# For Claude: Ajar

One little door a day to the big day - planned around your real week. A
countdown calendar of small things to do together, for **families with
kids** (and anyone counting down to something): Christmas, a birthday, a
trip, a new baby, the last day of school.

- **Set up in about a minute.** The big day: **Christmas** (doors 1-24
  December), **from the first Sunday of Advent** (the fourth Sunday before
  25 December, to 24 December - 26 doors in 2026) or **any big day** (its
  name and date, 3 to 31 doors, the last on the day before or on the day -
  and the page says which). Who's in: kids' first names or nicknames and
  ages ("first names or nicknames only", one line), grown-ups as a count.
  Busy evenings: weekdays tapped, plus busy dates; things on a fixed date
  ("School concert, Wed 16") that become their own quick door. A budget for
  the whole countdown (no money / a little / an amount) and how long a
  normal evening is (15 min, 30 min, an hour, two hours or more).
- **The deck**: 104 built-in activities in our own words, each tagged with
  a theme (winter festive / winter / any / birthday / trip), a time (5 min /
  30 min / an evening / half a day), a cost (free / a little / some, with a
  default amount the family can change), where (at home / out nearby /
  outdoors), mess (none / some / lots), a kind (the AI chips: crafts,
  baking, outdoors, music, building, reading, giving, science, games,
  quiet), ages and up to four things to buy or find, and a one-line how.
  Fillers for very busy days: 32 original jokes, 8 tiny treats and 6 notes
  to each other. Choose by **swiping** (a big card, right for yes, left to
  pass, Undo, arrow keys too) or **ticking** a list; filter chips; "Pick a
  good mix for us" (`starterPicks`: enough of each length for this
  family's week, kinds spread, inside the budget); add your own.
- **The plan** (`makePlan`), deterministic from a seed the page passes:
  pinned events on their date; opened doors and pinned days kept; **busy
  evenings get 5-minute ones and fillers**; **half-day ones on weekends**; a
  whole evening on a weekend or a weekday whose evening is an hour or more;
  **nothing that needs shopping on the first two days** (time to buy it);
  **no two messy ones in a row**; the kinds spread out; **the budget kept**
  (the dearest left out and named until it fits; "no money" places free
  ones only; an opened door's cost is spent, and when that alone is over
  the page says so plainly); empty days get fillers. Every day says why
  in a few words (`explain`). Tap two days to swap; pin a day; "Shuffle
  the unpinned"; from an opened door, "move it to another day". Every
  refusal carries a way out the page draws as a button: a fixed event ->
  "Change it in Setup", an opened door -> "Pick a door that's still shut",
  a pinned day -> "Unpin it and swap", a broken rule -> "Swap anyway" (the
  plan then lists what was moved against the rules).
- **The shopping list**: every planned activity's needs rolled up and
  de-duplicated ("paper plates" and "a paper plate" are one line), each to
  buy by the day before first use, grouped by week (a week all bought folds
  away), "Buy by tomorrow" flagged, ticked off, shared as plain text. The
  budget: per-door costs (amounts editable) and the total against it.
- **The doors**: a board in the countdown's look (winter festive, winter,
  birthday, trip, any time - drawn in CSS), the doors in a shuffled order
  fixed per countdown, the last one twice as wide, little decorations
  filling the last row so the board is a rectangle at every width. Today's
  door wiggles; future doors stay shut ("Opens Thursday" - a grown-up can
  peek in the plan); opening is a hinged swing with a small burst (reduced
  motion: a fade and words). Behind it: the activity, how, what is needed.
  Done (with an optional photo), skipped, moved, a star.
- **Kid mode on this phone**: only the doors, big; nothing to edit; future
  doors locked; leaving asks a grown-up sum ("7 + 5", four big choices,
  from a number the page passes). **A speed bump for small fingers, not
  security** - anyone who can add can leave. The back gesture does not
  leave it, and it survives a reload.
- **Print**: door cards 8 to a Letter sheet or 8 to an A4 sheet, edge to
  edge with dashed cut lines, each with the door number large, the day, the
  activity, how and what is needed ("Made-up example" on the demo's); and
  the fridge plan: one page, the weeks Monday to Sunday with each day's
  activity, busy evenings shaded, and the shopping with buy-by dates.
- **The end**: once the last door is open or the day has passed, the recap
  - opened, done, skipped, favourites, every door as a tick, the photos on
  this phone by day - and a **recap card** drawn on a canvas (1080 x 1350):
  the name, the counts, the doors as little ticks, the favourites, and a
  photo **only if ticked** (off by default - a picture of people is theirs
  to choose to send). Two taps: draw, then share as a **file**
  (`navigator.share({files})` where `canShare` allows, else a download).
  **Never a link, never uploaded.**

Built 2026-11-20 as an **everyday** drop: Waterfall (2026-11-11) was a
business one, so today was the other kind. **Staging only**: no custom
domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/ajar`,
served at `challenge.strongtechnicalconsulting.com/ajar/`, data in `ajar_*`
collections of the lab's `challenge` database, deployed with `gcpdeploy
ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes and
graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

An everyday free pick: no inbox idea waiting, no holiday today, and 1
December is eleven days away - families set these calendars up the weekend
before (in 2026 the first Sunday of Advent is 29 November). The job is
real and the scramble is familiar: twenty-four ideas to find, the busy
Tuesday that gets the messy baking, the craft that needed glue nobody
bought, the big outing that landed on a school night. Ajar plans the doors
around the week the family actually has.

It works for any countdown - a birthday, a trip, a new baby - and for
families who don't celebrate Christmas: winter and "any time" activities,
a custom big day, and **no religious content in the deck** (tested).

**Not a repeat.** **Tada** runs a child's daily routines; **Jars** is
pocket money; **Kindly** keeps track of people and gifts; **Pencil** keeps
game-night scores; **Chorus** splits chores. None of them plans a run of
small activities across real evenings, rolls up the shopping or prints
calendar cards.

**The market, checked (the brief's search, recorded here).** A web search
for "Ajar" app advent activity calendar family countdown found no app of
that name. Family activity-advent apps exist, but none plans around the
family's busy evenings and shopping, prints cards for a physical calendar
and keeps two parents in step.

**The made-up family.** The demo is the **Fernsby** family - Wren (7), Otto
(4), two grown-ups - all invented, first names only. A web search for
"Fernsby" family (2026-11-20) found genealogy pages for other surnames
(Fernaby, Fernyhough, Fersen) and nothing for Fernsby: no well-known public
family or brand of that name.

**No brands or titles, anywhere** - no toy, sweets, chocolate, drinks or
craft-kit brand, no shop, chain or delivery company, no film, show, book,
song or character (no named reindeer, snowmen, shelf elves or holiday
villains: "watch a film together", "read a winter story"), no streaming
service, no theme park, no advent-calendar product. The suite checks every
file for a list of them built from pieces (ordinary words only with their
capital), and the AI's answers go through the same kind of check.

**Who pays.** Almost nobody. Setup, the deck, the plan, the shopping list,
the doors, kid mode, printing and the recap are free, need no account and
work offline. A free account keeps up to three countdowns in step across
two phones. The one metered thing - "More ideas for us" - costs about a
cent (Haiku for the free tier, Sonnet for members, via
`identityLib.planFor`).

**How it becomes an iPhone app.** A widget with today's door ("Door 9 is
waiting"); a Lock Screen countdown ("16 sleeps"); the share sheet taking
the recap card; Guided Access around kid mode; a local notification at
teatime - none of which needs a server.

## The decisions that matter

- **One rules file, run three times.** `public/ajar-core.js` is UMD
  (`window.AjarCore` in the page, `require` in the server and tests): text
  cleaning and the @ / link / phone / formula / brand checks, dates (UTC
  day numbers, no Date object), the big days, the deck lookups, the one
  door (`cleanCountdown`), the planner and its reasons, swaps, pins and
  moves, the shopping, the doors, the kid-mode question, the print maths,
  the recap, the merge, and the AI request and answer. **No clock and no
  dice** (tested): today, every time stamp, every seed and the kid-mode
  number are passed in. The deck is its own UMD file (`ajar-deck.js`), the
  demo another (`demo.js`).
- **`cleanCountdown` is the one door**: every countdown read back from the
  phone or the account, or sent to the server, is rebuilt field by field -
  unknown fields dropped (strict: refused), enums, dates, ids and numbers
  checked, strings cleaned and bounded, kids' names letters only. Limits:
  6 kids (names 20), 10 fixed-date things, 31 busy dates, 40 of your own
  activities (titles 50, how 160, four needs of 30), 150 picks, 3
  countdowns.
- **Times, not versions, decide a merge.** Each plan day, each door and
  each shopping tick carries its own time stamp, and so do the setup and
  the deck as wholes. A refusal from the core is `{ok: false, msg, way:
  {label, act, force?, unpin?}}`; a change is `{ok: true, cd}`.
- **A moved door** swaps with the later shut day it is moved to: the
  activity goes there and what was there (often a filler) comes to
  tonight's door instead; the door says "Moved to Sun 13".

## The example (`public/demo.js`)

The Fernsby family (made up, said on every demo view and printed page)
counting down to Christmas: doors 1-24 December 2026, 21 activities, the
school concert on Wednesday 16 December pinned as its own quick door, and
2 fillers; Tuesday and Thursday evenings busy; $45 with $6 left. The clock
is fixed at **Wednesday 9 December 2026, 6:15 pm**: doors 1-8 open (six
done, each with a little drawn SVG "photo"; door 7, paper snowflakes,
skipped; door 6, the salt dough, moved to Sunday 13), door 9 wiggling
unopened, the shopping partly ticked with **bird seed due tomorrow**. A
guided tour of five steps - the doors (open today's), the plan (why each
day is where it is), the shopping list (what to buy by when), kid mode,
print the door cards - then "Make our calendar". "See how the example
ends" shows the recap of a finished run (20 done, 3 skipped, 5
favourites). The example is never kept, sent or synced (tested), and its
AI sheet shows a made-up answer run through the real checks, labelled as
an example.

## Storage: one module, photos on this phone only

`public/ajar-store.js` is the only module that touches browser storage
(IndexedDB, a `kv` store and a `photos` store, every access wrapped):
up to three countdowns (through the one door), the current one, this
phone's flags (tour seen, kid mode on, paper size) and per countdown the
account copy's time this phone last saw. A blocked database (a private
window) or a full one falls back to memory, reads back what it kept, and
says so (`persistent()`). `app.js` touches no storage itself (tested).

**Photos** are redrawn through a canvas at 1280 px (and a 320 px
thumbnail) - which drops EXIF, location included - and kept as JPEG data
URLs in the `photos` store: **never sent, never synced**, and one quiet
line on the page says so. Removing a countdown removes its photos.

## Sync (signed in, free) and the merge

`ajar_calendars/<owner tag>` = `{owner, countdowns: {<id>: countdown},
updatedAt}`, the tag an HMAC of the account id under a key derived from
`IDENTITY_SESSION_SECRET` ("ajar owner v1"). Up to three countdowns.
`PUT /api/countdowns/:id {countdown, base}` saves in a transaction only if
`base` matches that countdown's `updatedAt`, else **409 with the account
copy** (`code: 'conflict'`); a countdown removed on another phone is 409
`removed`, a fourth is 409 `full`. Refused whole (400) for an unknown
field anywhere, any string with an @ (any width), nine digits in a row (in
any script), a link, markup or an invisible character, or anything over its
limits; the
parser runs after the sign-in; 120 writes per account in ten minutes.

On a 409 the phone merges (`AjarCore.merge`): per plan day, per door and
per shopping tick, the later change wins - so an edit on one phone and a
door opened on the other both survive. A key both phones changed since
this phone's last sync takes the later change, and the page shows a small
**"Merged with your other phone"** note naming it. The merge is symmetric
and idempotent (tested, with keys in any order). Photos never travel.

## The model call (metered, signed in only)

**`POST /api/ai/ideas`** - "More ideas for us". `requireUser,
requireBudget, requireDailyCap` **then** the route's own 16 KB parser (401
/ 402 / 403 / 503 before it, never 413 - tested), then `ideasRequest`
rebuilds exactly `{theme, month, ages, likes, budget, count, avoid}` and
refuses anything else with a 400 and no model call: theme from the list,
month 1-12, ages whole numbers 0-17 (at most 6; a string is "Ages only,
as whole numbers - never names"), likes from the ten chips, budget free /
little / some (a set amount is spread over the doors), count 4-12, avoid
the built-in deck ids already chosen (at most 100; a custom id or a typed
title is refused - your own ideas are never sent). The server turns those
ids into the deck's own titles for the prompt.

One forced tool (`record_ideas`, built per request: `maxItems` = count,
the costs the budget allows, the ages in the description) through one
call site (`ai.ask`). `max_tokens = 300 + 200 x count` (an idea is about
130 tokens - a 50-character title, a 160-character how, four needs, the
enums and ages - with half again for headroom; 2,700 at twelve); a
`max_tokens` stop is a 502 "That answer ran long". The prompt: plain
activities at home or nearby; never a brand, shop, product, film, show,
book, song, character, website or place; nothing dangerous (no fire
beyond a grown-up lighting candles, no knives for small kids, no open
water or ice); match the ages; inclusive, no religious practice.

`cleanIdeas`: markup and bidi out; a field with an @, a link, a
phone-like number, a formula or a brand or title name dropped (and the
idea, when that takes its title or how); enums checked; ages clamped into
the asked range (no overlap drops it); a cost the budget does not allow,
a deck title, an already-chosen title or a repeat dropped; nothing usable
is a 422 in words. The page shows the cards labelled **"AI-written - check
they suit your family"**, and adds one to the deck (as your own, chosen)
only on a tap. Nothing is stored server-side. Before the tap the sheet
says exactly what is sent - "the kids' ages, the chips you picked, your
budget and the month - never names, never your own ideas" - and shows the
JSON. Signed out it offers a free account and the example; there is never
a model call for a signed-out visitor. 401 opens sign-in, 402 the credit
sheet, 403 `verify-email` its sentence and "Send the link again", 413 a
sentence.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8174/ajar/
npm test        # the rules, the demo, hostile input, storage, the page, the copy, then HTTP under /ajar
```

`AJAR_MEMORY=1` and `AJAR_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js` (the
tests spawn each with `K_SERVICE` set). `AJAR_COLLECTION_PREFIX` (`ajar_`
from the host) prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that does
not force a tool, keeps every request, answers with plain made-up ideas
sized to what was asked, and takes `fakeClient.mode` (`blank`, `bad`,
`inject`, `maxtokens`, `upstream401`, `upstream529`) for one call.

`test/run.js` (29 tests): the big days (Advent 2026-2030 against 29 Nov, 28 Nov,
3 Dec, 2 Dec, 1 Dec; any big day's counts and ends); the deck; the planner
by hand and as a property over 300 random families (every rule, nothing
twice, the budget, every pick placed or named); seeds; reasons; swaps,
pins and moves with every refusal's way out; the shopping roll-up; the
doors from a passed-in today; done, skipped and stars; the kid-mode
question; the card print maths for Letter and A4; the recap and the
card's text fitting; the two-phone merge; the demo's planted story
exactly; hostile text; the storage module (round trip, blocked and full
IndexedDB, photos); contrast in both themes and every calendar look, the
lab card's colours and their distance from the newest cards, 44 px (kid
mode bigger); the page's promises; no brand or title names, key-shaped
strings, invisible characters or email addresses in any file and model
names only in `MODELS`; the local switches and the prefix; and over HTTP:
signed out with zero model calls, cross-site writes refused, the gate
order before every parser, sync with its 409s and refused bodies, the AI
route (what the model saw, the answer checked, 422 / 502 / 503) and the
403 / 402 / 503 gates.

Rendered with Playwright at 390 px and 1280 px, light and dark: the first
run, every tour step, setup with each big day, the deck (swipe, list,
filters), the plan with its reasons, a refused swap with its way out and a
swap, the shopping list, the doors (today's wiggling, opening mid-swing,
done with a photo, a locked one), kid mode (a locked door, an open one,
the grown-up sum), the door cards and fridge plan on Letter and A4 (as
PDFs too: three pages of cards and one fridge page each, none blank), the
recap and its card, a merge from a second signed-in phone, and the AI
sheet (the example, signed out, signed in with what is sent, the
`verify-email` 403, the ideas labelled and one added). No console error or
CSP violation (the one 409 logged is the merge working), nothing scrolling
sideways. Then a hostile pass through the page (markup, bidi and
zero-width characters, an @, ten digits, a link, nine Arabic-Indic digits,
a 40-character name): no dialog, no injected element, no bidi character on
the page or in storage.

Found on the way: the recap card's favourites ran into its footer when
there were four and more (the grid now takes what they leave); nine
Arabic-Indic digits got past "nine digits in a row" (JavaScript's `\d` is
ASCII only; now `\p{Nd}` after NFKC, page and server); a redraw that
removed a focused field could start a second redraw inside the first (now
queued); the board left an empty last row at some widths (the column count
is now chosen per width and decorations fill the gaps); the merge compared
keys in written order, so the same data could look changed (now compared
canonically); a store write that failed (a full disk) was not read back
(now the memory copy wins); the plan and the shopping list ran long on a
phone (opened doors and bought weeks now fold away); a test planted
example times in the future, so a real swap lost to them (the example is
never synced; the test re-stamps it).

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/healthz`, `/api/meta`, `/api/me`, the page,
the service worker. Signed in, free: `GET /api/countdowns`, `PUT|DELETE
/api/countdowns/:id`. Metered: `POST /api/ai/ideas`. The shared account at
`/api/auth`. No route takes a photo (tested).

## Deliberately not built

- **Reminders or push** ("Door 9 is waiting!"): there is no sender on this
  platform; the iPhone app could do it locally.
- **A public share link of the calendar**: it would carry the kids' names
  and the family's photos. The recap card is shared as a file instead.
- **Buying the supplies, or links to shops**: the list is plain text.
- **Weather-aware planning** (the outdoor ones on dry days): a network
  call and a location for a small gain.
- **Religious content in the deck**: the deck is for every family; a
  family adds its own.
- **Several families on one calendar** (grandparents' house): one account
  is the household; two phones signed in to it stay in step.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks and
  changes routed by one listener each (tested here and by
  `challenge/test/lab.js`).
- Writes come from this page: every non-GET `/api/*` outside the shared
  account refuses `Sec-Fetch-Site` other than same-origin/none (403), an
  `Origin` naming another host (403) and a body that is not JSON (415).
- No model call for a signed-out visitor, ever; every sync and metered
  parser runs after its gates.
- Everything typed, synced or written by a model is untrusted: cleaned in
  the core (control, bidi and zero-width characters removed), bounded, and
  escaped on render (the test cuts out every `esc(...)` call and fails on
  anything else concatenated into markup). The recap card is drawn with
  `fillText`, which reads no markup.
- The service worker caches the app shell only - never api/, never a
  countdown or a photo.
- Failures: only the app's own errors reach the page in their words; a
  provider error is a 502 (503 "The AI is busy"). Nothing logged carries a
  body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
