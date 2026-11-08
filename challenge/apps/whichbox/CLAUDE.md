# For Claude: Whichbox

Which box is the kettle in? Label it, scan it, find it. For anyone moving
house, and anyone with boxes in a loft, a garage, a basement or a storage
unit - including the holiday-decorations boxes about to come down.

- **Boxes, added fast.** Each box gets the next number (a number is never
  handed out twice, even after a delete - its label may still be on a box).
  Pick the room it goes to (chips with each room's colour; add a room
  inline), type what goes in and press Enter (or paste "plates, bowls,
  mugs"; each thing starts with a capital), with suggestions: what usually
  goes in that kind of room, then words this move already uses - and, when
  Open first is ticked, the first night's things (kettle, chargers, toilet
  roll...). Flags: Fragile, Open first, Heavy, This way up, Valuables (with
  "keep valuables with you - never printed on the label"). An optional photo
  of the open box (shrunk to 1200 px through a canvas, EXIF and location
  dropped, kept in IndexedDB on this phone; one quiet line says so), and a
  note. "Save box 15" or "Save, add 16" (which keeps the room).
- **Statuses.** A move: Packed -> Loaded -> Delivered -> Unpacked. Storage:
  In storage <-> Taken out. A box's page has the next step as one big button
  ("Mark delivered ✓") - which is what scanning its label opens - and every
  status one tap away to undo a mis-tap; a toast offers Undo too.
- **Labels.** A print page for Letter or A4, six to a page (for boxes) or
  two (big ones), all boxes / new since the last print / one room / one box,
  contents on or off. Each label: the number huge, the room as a coloured
  band with its name in capitals, the flags as bold boxed WORDS, the
  contents, the move's short name, and a QR code drawn on the phone that
  opens that box. A live preview of page 1. **Room signs**: one page per
  room - the colour band, the name huge, "Boxes 1-3, 14" and a tick-off grid
  of those numbers - to tape on each door of the new place.
- **Find it.** Search across contents, rooms, notes, places and tags:
  "kettle" -> "Box 14 · Kitchen · Delivered", with the number large in the
  room's colour. Forgiving (below). When nothing matches it names the boxes
  with nothing listed yet - where an unlisted thing might be.
- **Moving day.** "9 of 18 boxes in the new place" with a stacked bar,
  "Go to box number…", the Open first boxes pinned (not yet delivered
  first), "Loaded but not delivered" (on the truck - or missing once the
  truck is empty), room by room ("Kitchen: 3 of 4 delivered", each
  expandable to its boxes), not loaded yet, and one-tap status on every row.
- **Storage mode.** The same boxes with a place ("Loft left", "Garage shelf
  2") and seasonal tags (Holiday decorations, Summer, Winter, Camping,
  Keepsakes...). "What's where" groups by place (however it is typed),
  filters by tag, and keeps "Taken out" on top with "Put back".
- **Share a move with helpers** - no account (below).
- **Spreadsheet.** CSV of every box and its contents, formula-safe, and
  back in (numbers already used are skipped and counted).
- **Try it**: a made-up move from 12 Larkfield Lane to 4 Harbour Row,
  halfway through moving day - 18 boxes, three invented helpers (Noor, Ezra,
  Juno), the kettle in Box 14, one box packed in a hurry with nothing
  listed, a valuables box "in the car with us" - and a made-up loft (eight
  boxes, holiday decorations in Loft left). Every tap works; nothing is
  saved; a ribbon says so.

Built 2026-11-08 as an **everyday** drop: Replay (2026-11-07) was a
business one, so today was the other kind. **Staging only**: no custom
domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/whichbox`,
served at `challenge.strongtechnicalconsulting.com/whichbox/`, data in
`whichbox_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

"Which box is it in?" is a universal, maddening question - during a move,
when forty boxes are in the hall and the kettle is in one of them, and every
December, when the decorations come down from the loft. Writing "KITCHEN"
on a box in marker answers the wrong question. A numbered label with a QR
code and a searchable list answers the right one: search "kettle", get Box
14, see the 14 from across the room.

Moving day adds a second problem: helpers. Friends carrying boxes need to
know where each one goes (a colour band and a room name they can match to a
sign on the door), and whoever is directing needs to know what has arrived
and what is still on the truck - or missing. A shared move with a code
gives every helper the same list and lets them tick boxes off as they come
in.

**Not a repeat:** Sorted is decluttering (keep / sell / donate / toss),
Boomerang is things lent, Takeback is returns, Boxed is K-1 tax forms.
Whichbox is knowing what is in which box.

**Who pays.** Almost nobody. Moves, storage lists, boxes, photos, labels,
signs, search, moving day, sharing with helpers and the CSV are free, need
no account and make no model call. A **free** account adds one metered
thing: "List what's in this box" from one photo (Haiku free, Sonnet for
members via `identityLib.planFor`), about a cent.

**How it becomes an iPhone app.** The camera opening a label's QR straight
into the app (universal links), a widget with "Kitchen: 12 of 14
delivered", NFC tags as an alternative to QR stickers, Live Text to read a
handwritten box number, and printing to a label printer.

## The decisions that matter

- **One rules file, run three times.** `public/whichbox-core.js` is UMD
  (`window.WhichboxCore` in the page, `require` in the server and tests):
  text cleaning, ids and codes, rooms and colours, flags, statuses, boxes
  and moves, search, moving day, storage, the CSV, links and hash routes,
  the label and sign maths, sharing's payload and the server's view, the AI
  request and answer, and the made-up data. **No clock and no dice**
  (tested): "now" and every new id are handed in, and a drawn id already in
  the move is drawn again (`freshId`).
- **Numbers are never reused.** `nextNo` is the larger of the move's
  counter and its highest number + 1, so deleting Box 9 does not make 9 the
  next number. A typed number in use is a 409 that names the next free one.
- **Room colours.** Fourteen colours, each keeping white text at 4.5:1 or
  better - and, because a black-and-white printer keeps luminance, in grey
  too (tested both ways). The colour is never the only signal: the band
  carries the room's name in capitals, chips carry the name beside a dot,
  and the room sign repeats the name in black.
- **Room kinds.** Every room has a kind (kitchen, living, dining, bedroom,
  bathroom, office, kids, garage, storage, laundry, outdoor, other), worked
  out from its name ("Nursery" -> kids, "The shed" -> garage). Kinds pick
  the starter words, and let the AI suggest a room without ever seeing a
  room's typed name.
- **Valuables is never printed.** A label that says "valuables" tells
  everyone on the pavement which box to take. The flag lives in the app
  only, with "keep valuables with you".
- **Search** (`search`): every word of the query must match somewhere in one
  box. A word matches another if it is the same, a plural or singular of it
  (`forms`: mugs/mug, knives/knife, shelves/shelf, gloves/glove,
  batteries/battery, boxes/box), the start of it (the last word, while
  typing), or a small typo (one slip from 5 letters, two from 8; never a
  typo of a short word - "tool" is not "too"). Accents fold away (café,
  crème brûlée). "14", "#14" and "box 14" open Box 14. Contents weigh more
  than rooms and places, which weigh more than notes. One spelling per
  thing (`itemKey` / `stem`) stops "Mugs" and "mug" being listed twice.
- **Labels in millimetres** (`labelGrid`, `labelHeight`, `fits`): a sheet
  is exactly the printable area of the paper (10 mm margins, 2 mm spare),
  split into 1 x 2 or 2 x 3 labels with a cutting gap. Letter 6-up labels
  are 94.9 x 81.8 mm, A4 92 x 87.6; the rows (number and a 27 mm QR, a 15
  mm band, flags, two contents lines, the footer) are budgeted to fit every
  paper and count (tested). Long room names are squeezed to the band
  (`textLength`), four-digit numbers shrink beside the QR, contents end in
  "+N more". The band is **SVG**, so it prints even when the browser's
  "background graphics" is off (checked in a PDF made without it). The page
  size goes in an injected `@page` rule; `@media print` shows only `#print`.
  Checked in Chromium's PDF: Letter 6-up 18 labels = 3 pages, A4 2-up = 9,
  nine room signs = 9.
- **QR payloads**: a box on this phone opens `<base>#box/<id>`; a shared
  move's box `<base>#s/<move id>/<box id>`. **A label never carries the join
  code** - boxes sit on pavements and in vans. A stranger who scans a shared
  label sees the join screen, never the box. Sharing keeps every box's id,
  so a label printed before the move was shared still opens the box on a
  joined helper's phone (`#box/<id>` is looked up in joined moves too). The
  payload stays at QR version 6 or less (tested), half a millimetre a
  module at 27 mm.
- **Neutral copy**: they and them, never a gendered pronoun (tested over
  every string and this file).

## Sharing a move (no account)

The owner taps Share with helpers and types a first name. The page sends
the move's name, where it is going, its rooms (`shareMeta`), then its boxes
in batches of 50 (`shareBox`: id, number, room, contents, flags, note,
status, place, tags) - **text only**. From then on the owner's writes go to
the server and the phone keeps the last copy it saw (plus its own photos).
An invite sheet shows the code, its QR and "Send the link"
(`#join=<code>`: the code rides in the fragment, never sent to a server or
in a Referer).

- **Photos never reach the server.** Every share route refuses a request
  that carries anything picture-like - a key named photo / image / thumb /
  picture / blob, a `data:` URL, or a long base64 run with capitals, small
  letters and digits in it (`carriesPhoto`) - whole, with a 400 `photo`
  (tested on create, batch, add, edit and rooms). The shared view says
  "Photos stay on the phone that took them".
- **Helpers** join with the code and a first name ("Noor"; a name already
  there gets a number). They see every box, search, open labels, and change
  a box's status - with their name on it ("Delivered by Noor · 2:14 PM").
  They cannot add, edit or delete boxes, change rooms, see the code, rotate
  it or remove anyone (403, tested). A helper can leave.
- **The owner** does everything: boxes, rooms, the name, remove a helper
  (their ticks stay), a new code (the old one dies at once; helpers already
  in stay), Stop sharing (the server copy and every box go; the phone keeps
  its own). The owner cannot "leave" - only stop.
- **Members are browsers.** An HttpOnly cookie `whichbox_k` (22 random
  characters, `Path` = the app's base, SameSite=Lax), minted on share or
  join; the move keeps only `sha256("whichbox member v1:" + key + move id)`
  per member, so one phone is unlinkable across moves. No account, no email.
- **One document per box** (`boxes/<move id>_<box id>`), and every write is a
  patch of keys in a transaction: a helper's Delivered writes `status`,
  `statusAt`, `statusBy`, `updatedAt`; the owner's edit writes only the
  fields that changed (`boxPatch`). Ten helpers marking ten boxes at once
  all stick, and the owner editing a box's contents while a helper marks it
  Delivered both stick (tested; the test also shows one list in one
  document losing a write).
- **Numbers in a transaction.** The move keeps `nos: {n<number>: <box id>}`,
  so a new box's number is decided inside a transaction on the move - ten
  boxes added at once get ten numbers. The box is written **before** the
  version moves, so a phone polling in between never sets its version past
  a box it has not seen.
- **Polling**: `GET /api/m/:id?since=v` answers `{same: true}` when nothing
  moved (one read); phones re-ask every 15 s while a shared move is on
  screen and when the app comes back; a redraw waits while someone types. A
  write answers `{box, v, was}`, and the page moves its version only if it
  was at `was` - otherwise the next poll fetches everything.
- **Expiry on read**: a shared move nobody has opened or changed for **90
  days** is deleted, with its boxes, by the read that finds it (no timer).
  Opening one counts (`activeAt`, written at most every 6 hours), so a
  household's shared loft does not vanish while people still look at it.
  When it goes, the owner's phone turns its copy back into a device-only
  move and says so; a helper's phone drops it.
- **The same 404, word for word**, for an unknown id, a malformed one, one
  that expired and one that is not yours ("This move isn't shared here...",
  `code: 'gone'`).
- **What a code opens** before joining: the move's name, who shared it, the
  number of boxes and helpers - nothing in any box, not the address.

### Limits (per instance, in memory: they slow a script, they do not stop a determined one)

`lib/moves.js` LIMITS and `Core.LIMITS`: 50 helpers a move, 500 boxes, 50
boxes a batch, 80 things a box (60 characters each), notes 300, rooms 24;
10 shared moves per address an hour; 30 new helpers per address an hour;
**30 distinct wrong codes or ids per address in 15 minutes, then even the
right one waits** (a phone polling the same dead id counts once); 900
writes per address and 400 per member in 10 minutes. IPv6 counts by its
/64. 20 moves and lists on one phone.

## The model call (metered, signed in only)

**`POST /api/ai/contents`**: `requireUser, requireBudget, requireDailyCap`
**then** the route's own 1.4 MB parser (401 / 402 / 403 / 503 before it,
never 413 - tested), then `ai.brief`: exactly `{image: {type, data}}`, a
JPEG or PNG **by its bytes**, at most 1 MB and 1600 px a side, its metadata
stripped again (`lib/image.js`) - a 400 costs nothing. Then one forced tool
`record_contents` through one call site (`ai.ask`), told the photo and one
fixed sentence - nothing about the person (tested by reading the fake's
log). Then `cleanAiAnswer`:

- at most 40 items, each plain, under 40 characters, no markup, no links, no
  long numbers, no repeats (by `itemKey`);
- a room **kind** from the fixed list, or `unsure` - never a room name; the
  page maps the kind onto the move's first room of that kind;
- flags only `fragile` or `heavy` (never Valuables), confidences from
  high / medium / low;
- nothing usable is a 422.

Nothing is stored. The sheet says what is sent before the tap ("this one
photo, shrunk on this phone with its location removed. Nothing else - not
your move's name or address, your rooms, or what's already listed"),
labels the answer "AI-written - check every line", unticks things already
in the box ("Already listed"), and adds only what is ticked - to the add
form or to an existing box (and keeps the photo with the box, on the
phone). Signed out it explains and offers a free account; Try it says it is
for your own boxes; 401 opens sign-in, 402 the credit sheet, 403
`verify-email` its sentence and "Send the link again"; sheets size
themselves below the confirm-your-email banner.

## On the phone

`whichbox-data-v1` (moves and lists: rooms, boxes, a shared move's last
copy, its members' first names and version), `whichbox-prefs-v1` (paper,
labels per page, contents on labels, the last room used per move),
`whichbox-me-v1` (the first name last used) in localStorage; photos in
IndexedDB `whichbox` / `photos` (`p-<box id>`: a 1200 px JPEG and a 240 px
thumbnail). Every access wrapped in try/catch; without storage the page
works in memory and says once that nothing will be kept. Paper defaults to
Letter for US, Canada and a few Latin American locales, A4 elsewhere; a
locale Intl refuses ("en-US@posix") falls back to en-US.

## Offline

The service worker (`sw.js`, network first, `whichbox-shell-v1`) keeps the
app's own files, so a device-only move works fully offline - adding boxes,
search, moving day, labels, signs, CSV. It **never** answers `api/`. A
shared move offline shows the last copy with "You're offline - this is the
move as of 3:42 PM. Changing a box needs the internet.", and a write says
the same.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8163/whichbox/
npm test        # the rules first, then end to end over HTTP under a /whichbox mount
```

`WHICHBOX_MEMORY=1` and `WHICHBOX_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `WHICHBOX_COLLECTION_PREFIX`
(`whichbox_` from the lab host) prefixes every collection. `npm test` runs
with `REQUIRE_VERIFIED_FOR_FREE_AI=0` (the gate itself is held by the
suite's gate test and by the lab's). The fake refuses a call that does not
force a tool, keeps every request (`fakeClient.calls`), and takes
`fakeClient.mode` for one call: `blank`, `inject`, `unsure`, `maxtokens`,
`upstreamNNN`.

`test/run.js` (36 tests): text and hostile input, codes, box numbering (never
reused, 409 naming the next, a drawn id never reused), rooms and colours
(white text in colour and in grey, kinds, unique names, a room in use kept),
flags (Valuables never printed), statuses and transitions, search (plurals
both ways, accents, typos, prefixes, numbers, AND, no false typos),
suggestions, moving day, storage, the CSV (round trip, formulas defused and
restored, duplicates skipped, odd files), QR payloads and hash parsing, the
label and sign maths for every paper and count, cleaning a stored move,
sharing's text-only payload and `carriesPhoto`, the server's view, the AI's
request and answer, the made-up move, contrast in both themes plus the
literal colours and the lab card, 44 px targets, the page's promises
(relative URLs, no inline script, the banner, wrapped storage, photos
redrawn, every received string escaped, only the listed API paths, what
the AI sheet and the share sheet say, the offline line, the service
worker), neutral copy, no invisible characters or key-shaped strings, the
local switches, single-field queries; and over HTTP: signed out with zero
model calls and a 401 before the AI parser, cross-site writes refused, the
gate order and the owner check before the batch parser, share / join / the
key cookie and its per-move hash, helper vs owner powers, concurrent
statuses, edits and adds, the same 404 and expiry on read, the limits,
hostile input end to end, no photo accepted anywhere, the AI over HTTP,
the 403 / 402 / 503 gates, and nothing identifying in the store.

Rendered with Playwright at 390 px and 1280 px, light and dark: the first
run, Try it (moving day, boxes, find "kettle", Box 14, labels, More),
starting a move, adding boxes quickly and with a photo, the box page with
its photo, a CSV import, labels (Letter 6-up and A4 2-up in print emulation,
each saved as a PDF and counted page by page; once without background
graphics), room signs, moving day, sharing and the invite sheet, a helper
joining in a second browser and marking a box Delivered from its scanned
label, a stranger scanning the same label (the join screen, nothing of the
box), the owner seeing "Delivered by Noor", the helper offline, the AI sheet
signed out, signed in (and the verify-email 403), its proposal and adding
it to a box and to the add form, storage mode (a box with a place and a
tag, what's where, the switcher, the made-up loft by tag), a sheet under
the confirm-your-email banner, the lab card on the landing page and the app
under the lab host. No console error or CSP violation, nothing scrolling
sideways. Then a hostile pass (markup, bidi, zero-width and very long names,
rooms, items and notes through the page): no dialog, no injected element, no
bidi character on the page. Found on the way: deterministic test dice
repeated ids (now `freshId`), "Knives" and "knife" were two things (now one
stem), a long run of one key was taken for a photo (the detector now wants
mixed base64), the header wrapped at 390 px, and the room-sign page had an
empty half (now a tick-off grid).

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`). `public/qr.js` is
Chapter's copy of the vendored Kazuhiko Arase MIT "QRCode for JavaScript",
global renamed `WhichboxQR`. `lib/image.js` is Takeback's.

## Data (Firestore: `whichbox_*` in the lab database `challenge`)

Only shared moves are ever on the server.

- `moves/<id>` (16 random base64url characters) - `{name, kind, from, to,
  rooms: [{id, name, color, kind}], code, members: {<mid>: {name, role:
  owner|helper, keyHash, joinedAt, at}}, nos: {n<number>: <box id>},
  nextNo, v, createdAt, updatedAt, activeAt}`.
- `boxes/<move id>_<box id>` - `{move, bid, no, room, items, flags, note,
  status, statusAt, statusBy (a member id), location, tags, createdAt,
  updatedAt}`.

No email, no account id, no browser key, no photo anywhere (tested over the
whole store). Queries are single-field equality (`code ==`, `move ==`), so
**no composite index**.

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, the page, `sw.js`. No
account: `POST /api/moves`, `GET|POST /api/join/:code`. Members
(`/api/m/:id`): `GET` (`?since=v`), `PUT box/:bid/status`, `DELETE me`.
Owner: `POST boxes` (a batch), `POST box`, `PATCH box/:bid`, `DELETE
box/:bid`, `PATCH` (name, places, rooms), `DELETE members/:mid`, `POST
code`, `DELETE /api/m/:id`. Metered: `POST /api/ai/contents`. The shared
account at `/api/auth`.

## What is deliberately not built

- **An in-app scanner.** The phone's own camera reads the label's QR and
  opens the box; `BarcodeDetector` is not in iOS Safari, and a camera
  permission prompt for something the camera app already does is friction.
  "Go to box number" covers a damaged label.
- **Label-sheet templates** (Avery and friends): plain paper and tape work
  everywhere; a template is a list of exact sizes to maintain.
- **Moving the owner's seat to another phone** (Chapter's one-time link):
  the owner's phone holds the move; another phone can join as a helper.
- **Sync of a device-only move across the owner's own devices**, and keeping
  shared moves on an account: an account is not needed for anything but the
  AI, and the brief kept it that way.
- **Delta polling** (only the boxes changed since `v`): a changed move is
  re-read whole. Fine for tens of boxes and a few helpers; past a few hundred
  boxes and many helpers, a `marks` map on the move would cut reads.
- **Notifications** ("Box 13 delivered"): no sender on this platform.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the AI route's gates run
  before its parser; the batch route's owner check runs before its 256 KB
  parser; every other route keeps a 16 KB limit.
- Writes come from this page: every non-GET `/api/*` outside the shared
  account refuses `Sec-Fetch-Site` other than same-origin/none (403), an
  `Origin` naming another host (403) and a body that is not JSON (415).
- Every name, room, item, note, place and model answer is untrusted:
  cleaned in the core (no markup, bidi or invisible characters, bounded;
  names letters only) and escaped on render (the test cuts out every
  `esc(...)` and fails on a field concatenated into markup); label text in
  SVG is escaped too; the QR's label is stripped of markup.
- `Referrer-Policy: no-referrer` and `noindex` on the share APIs; codes
  travel in fragments only, and labels never carry them.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body, a photo or what is in anyone's boxes.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
