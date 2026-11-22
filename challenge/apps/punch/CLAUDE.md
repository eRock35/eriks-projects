# For Claude: Punch

Walk the job, pin every fix on a photo, close it out with a before-and-after
the client signs. For **contractors, remodelers, builders and handymen**.

**This is a rebuild of the 2026-11-17 drop.** Punch was first built and
reviewed on 2026-11-17, then lost with its build container on 2026-11-20
before it was pushed. Erik asked for the lost drops back on 2026-11-21. Its
code and brief did not survive; this was built fresh from the
reconstructed spec in the repo-root `HANDOFF.md` ("Punch - business"),
which kept only its name, tagline, audience, emoji and colours. Everything
that spec names is here. It drops again as drop #69 on 2026-11-22, the last
of the eight rebuilds.

- **Jobs and areas.** A job (its name, and the client's name for the
  closeout - optional) holds rooms or areas ("Kitchen", "Main bath",
  "Front porch"). Each area has one "before" photo.
- **Pins.** Tap "Drop a pin", then tap the photo where the fix is: a
  numbered pin with its trade (a list to pick from, or typed), priority
  (high, normal, low), due date and a short note. Numbers run across the
  job and are never reused while a higher one lives, so "#7" is the same
  pin on every list and both phones. A pin can be moved, edited, removed.
  A phone without the photo (the other phone on the job) still draws the
  pins, in the photo's shape, on a placeholder.
- **Open -> fixed -> verified**, each with the day it got there; reopen
  from either. Fixed and verified pins take an "after" photo, shown beside
  a close-up of the "before" (the area photo zoomed on the pin,
  `PunchCore.crop`). Past-due open pins are flagged.
- **A list for each sub**: every open fix grouped by trade, high priority
  first then the soonest due, with the room - shared or copied as plain
  text (no photos), or printed with a tick column. "Fixed - to check" and
  "Everything" lists too.
- **The client signs on the phone**: a canvas pad (finger, pen or mouse,
  by pointer events), their typed name and the date. The sign-off keeps
  the counts it covered (open, fixed, verified) and says how many pins
  changed after it. Signing with fixes still open is allowed and said.
- **The printable closeout**: each area's photo with its pins and a table,
  every before/after pair, and the signature with the name and date;
  "Prepared by" from More (kept on the phone). `@media print` prints it in
  the light tokens; "Print or save as PDF" calls `window.print()`.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/punch`,
served at `challenge.strongtechnicalconsulting.com/punch/`, data in
`punch_*` collections of the lab's `challenge` database. See
`challenge/CLAUDE.md`. Every browser URL is relative to `BASE`. Staging only.

## Why it exists

A **business** drop. The end of every remodel is a punch list: a walk
through the house with the client, a notepad of "touch up here, that door
sticks", then texts to five subs and a week of "which outlet?". A pin on a
photo answers "which", the trade list goes to the right sub, and the
signed before-and-after closes the job.

## Photos never leave the phone

Each area's photo and each fix's after photo are **redrawn through a canvas
on the phone** (`shrink` in `app.js`: at most 1600 px, JPEG) - so the
location, camera and every other detail the file carried are gone - and
kept in IndexedDB through `punch-store.js` only (`photo:<area>`,
`after:<pin>`). The client's signature is the PNG the pad draws, kept as
`sign:<job>`. **Photos never leave the phone** and none of them is ever
synced or sent: they leave only inside a closeout the person prints or
saves. The page makes one kind of request besides sign-in (`api/sync`), and
its body is `PunchCore.cleanBook(book)` - text only; the server refuses
anything that looks like a picture (`data:` or base64) whole. Nothing
personal is kept beyond what the person types, and the text door refuses
an @, a link, a phone number, nine digits, a card number, markup, a leading
formula and invisible characters in every field.

## The book and the merge (public/punch-core.js)

The core runs in the page, the server and the tests, with no clock, no
dice, no network and no storage. The book: `jobs`, `areas` (with `ar`, the
photo's shape), `items` (the pins) and `signs`. A pin's fields are in three
parts, each with its own time: **where** (`x`, `y` per mille; `tp`), **the
work** (`trade`, `pri`, `due`, `note`; `tw`) and **how far** (`state`, `sd`;
`ts`); plus `n` (its number) and `c` (when it was made). A removal is a
record of its own (`del: true` and its time); removing an area or a job
removes its pins at the same time (and the job its sign-off).

Two phones on one job are merged **pin by pin, not whole-job
last-write-wins** - and inside a pin, part by part:

- **Each part of a pin: the later change wins.** One phone marking #4
  fixed while the other rewrites #4's note keeps both. At the same moment,
  the larger value compared canonically, so both phones pick the same one.
  Only when both phones changed the same part since they last agreed
  (`since`, the sync base) is a note shown.
- **A removed pin against an edited one:** the edit wins only if it came
  **after the removal** (a fix changed after someone removed it is kept,
  and said so); otherwise it stays removed. At the same moment, removed.
- **Two new pins with one number** (both phones added a #13 offline): the
  older keeps it, the newer gets **the next free number**, and it is said.
  Numbers only go up - the merge of two numberings of one pin is the
  larger - so a stale phone cannot bring a duplicate back.
- **A removed area or job against a pin changed later:** the pin is kept
  and its area and job come back; pins that did not change after the
  removal stay removed with it. Renaming an area after the other phone
  removed it keeps the area.
- **Jobs, areas and the sign-off:** the later one wins; a removed job takes
  its sign-off with it.

Tested in `test/run.js`, "merge 1" to "merge 8": different pins, the same
pin's parts, the same part (and a tie), removal against edit in both
orders, the duplicate number (and a third stale phone), the removed area
and job, the sign-off, then 400 random pairs and 150 random triples from a
shared start - symmetric, idempotent, absorbing (merging an input again
changes nothing), convergent (two phones that synced in different orders
agree once they meet; the merge is not associative in its numbering, only
convergent), always through the strict door, never two live pins with one
number. Over HTTP: two signed-in phones on one job, each editing offline,
the stale one's 409, its merge and save, both ending with every change.

## Sync (signed in, free)

`books/<tag>` = `{owner, book, updatedAt}`, the tag an HMAC of the account
id under a key derived from the session secret (`"punch owner v1"`). `PUT
/api/sync` saves only against the version the phone last saw; otherwise 409
with the account's copy, and the phone merges (`mergeIn` in `app.js`) and
saves again. Bodies are refused whole for any unknown field, an @, nine
digits, a link, markup, an invisible character, a picture, a phone number
or card in any text, a pin off the photo, more than 60 jobs, 400 areas or
3,000 pins, or ~900 KB. 120 saves per account in ten minutes. Signed out,
everything works on the phone.

## No model call

There is **no model call** anywhere: nothing here a model would do better
than the person walking the job. No location either. `PUNCH_FAKE_AI`
exists only because the lab host sets `<SLUG>_FAKE_AI=1` for every app on a
local run; like every sibling, it is refused on Cloud Run (as is
`PUNCH_MEMORY=1`). The shared identity is still mounted (sign-in keeps two
phones in step, and the verify banner asks it).

## The example (`public/demo.js`)

A made-up kitchen and bath refresh for an invented client, Odalys
Brennecke: three rooms drawn as SVG pictures (so every pin and every
after has something to show), twelve pins - 7 open, 3 fixed, 2 verified;
#2, the sagging cabinet door, was due "yesterday" (the demo's fixed day is
2026-11-22); the tile sub has #6 then #4. A six-step guided tour: the job;
drop a pin by the window; verify #3 with its after beside the before; copy
the tile list; the client signs (the tour draws a signature); the
closeout. Never kept, sent or synced.

## The look

Cool paper surfaces in light and dark; the original card's red (`#d00000`,
a touch deeper, `#c40000`, for text) and blue (`#0044d6`) in the app. The
lab card's colours were nudged (see `lab.js`: every red that holds white
text was taken, so the card is a dusty rose and a cobalt). Pins are red
(open), amber (fixed) and green with a tick (verified), always with their
number, and every pin is a 44 px button around a 30 px dot. Every text
token holds 4.5:1 (tested from the CSS); the signing pad is white paper in
both themes. Nothing sideways at 390 px; tables scroll in their own box;
reduced motion respected; a print sheet. 📌 is on no other card.

## Files

`server.js` (routes, gates, sync), `lib/store.js`, the five shared `lib/`
files and three shared `public/` files (synced by `scripts/sync-shared.js`;
never edit the copies), `public/punch-core.js`, `public/punch-store.js`,
`public/demo.js`, `public/app.js`, `public/app.css`, `public/sw.js`,
`test/run.js`. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0
PUNCH_MEMORY=1 PUNCH_FAKE_AI=1`; `npm run dev` serves it at
`http://localhost:8181/punch/` with the memory store.
