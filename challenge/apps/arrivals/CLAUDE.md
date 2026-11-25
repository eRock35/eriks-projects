# For Claude: Arrivals

Who lands when, and who's picking them up - the whole family's arrival board
on every phone.

Built 2026-11-25 (the Wednesday before Thanksgiving, the busiest travel day
of the year) as drop #71, an **everyday** drop: the newest regular drop
before it, Punch, was business. Not a holiday drop - Thanksgiving's own is
the 26th - but the job the day creates.

## Why it exists

When family and friends converge on one house for a holiday (or a wedding, a
reunion, a weekend away), the logistics live in a messy group chat: who is
flying into which airport, which train, who is driving and when they will
roll in, who is picking whom up, and what changed when a flight slipped two
hours. Someone always waits at the wrong terminal.

## What it does

- **A gathering in seconds, no sign-in.** A first name, where everyone is
  headed ("Mom's house"), the dates and the place's time zone. The phone
  gets a six-character code and a link (`#join=<code>`, in the fragment,
  never sent to a server or a Referer). Anyone joins with the code and a
  first name.
- **Arrivals, and trips home.** Each person adds their own - or one
  organiser adds everyone's: who, how (flight, train, bus, driving), from
  where, the airline or operator and number, the airport or station, the
  local time there and its time zone, how many people, checked bags, a car
  seat, a note for the driver.
- **The board.** Every trip by its expected time, grouped by day, in the
  gathering's own time zone. One tap moves a trip scheduled -> on the way ->
  landed -> here (a drive has no "landed"; a trip home is scheduled ->
  left); "Late +20" on the row, +20 / +40 / +1 hour and "Back on time" in
  the trip's sheet. A trip 20 minutes past its time with no update says
  "Due - no update". Counts on top: coming, here, delayed, need a ride.
- **Pickups.** Who still needs a ride ("I'll get them" claims it in a tap);
  clashes; pickups that could be one run ("I'll take both"); your runs for
  the day with people, bags and car seat added up; everyone else's runs.
- **The day's plan**, as plain lines to copy into the group chat
  (`Core.briefing`: rules, not a model).
- **Fill it in from a confirmation** (signed in, metered - the one model
  call): paste a booking email or add a screenshot, and it comes back as a
  draft in the form, which the person checks before saving.
- **See a made-up family's board** (`#try`): Thanksgiving at Mom's, drawn
  by the same code and changed by the same rules, in memory only.

**No flight-status feed, no location.** A flight tracker would need a new
key, which a daily drop never creates - and the family knows first anyway.
Travellers (or anyone in the group) say where they are. Do not add an
external status API here; if Erik wants one, it is his to set up.

**Where it lives:** `challenge/apps/arrivals`, served at
`challenge.strongtechnicalconsulting.com/arrivals/`, data in `arrivals_*`
collections of the lab's `challenge` database. See `challenge/CLAUDE.md`.
Every browser URL is relative to `BASE`; keep it that way.

## Time zones: the rule

A trip is typed as a **wall-clock time at the place it happens** ("lands
3:10 PM at O'Hare") with that place's IANA zone - by default the
gathering's, because the arrival airport is near the house; the form lets
it be changed. `Core.zonedToUtc(local, tz)` turns the two into **one
instant** (`at`), on the server: a phone never sends an instant. Everything
is sorted, compared and grouped by instants; `Core.zoneLocal(ms, tz)` turns
one back into a wall clock, so **the board shows every trip in the
gathering's zone** whatever zone it was typed in and wherever the phone is.
A trip typed in another zone also says what it read there ("1:10 PM PST
there"), and the board says "All times are Chicago time (CST)" - adding
"not where this phone is" when the phone is elsewhere.

- The zone rules are the platform's (`Intl.DateTimeFormat`), never a table
  here. A zone is valid if `Intl` accepts it (and it looks like one).
- **A time that happens twice** (the hour the clocks go back) is the first
  one. **A time that never happens** (the hour they go forward) moves
  forward by the gap, as a wall clock would have read. Tested north and
  south of the equator.
- Days are the gathering's: a 10:30 PM landing on the west coast is on
  tomorrow's list at a house in Chicago.
- A delay is minutes added to the instant, so a late flight can cross
  midnight and move to the next day's list; the old time stays, struck
  through.

## Who needs a ride, clashes and runs (`Core.issues`, `combos`, `runs`)

A **ride** is a trip that is not a drive, not finished (here / left) and not
"making their own way". For a trip home the time that matters is **when to
be there** (`Core.meetAt`): 90 minutes before a flight, 30 before a train
or bus - a stated rule, said on the page, not a prediction. A ride more
than six hours past raises no flag.

- **Needs a ride**: nobody is down to drive it (or the driver left or was
  removed).
- **Clash**: ONE driver due at two different places less than **90 minutes**
  apart.
- **Two places, one hour**: rides at different places within **60 minutes**
  with a driver missing from either - "that takes two drivers". Said once
  per pair of places (the closest pair), so three people at one airport and
  one at the station is one line, not three.
- **Could be one run**: rides at the same place within **45 minutes** of the
  first (greedy from the earliest), unless one driver already has them all.
  The suggestion names the one driver already going, if exactly one is.
- **The same place** (`Core.hubKey`): an airport by its three-letter code
  wherever it appears ("ORD", "O'Hare (ORD)", "ORD Terminal 3"); anything
  else by its words with "airport", "station" and the like taken out. No
  place given is never "the same place".
- Seats are not counted (nobody types how big their car is); the people,
  bags and car seats are added up so a driver can judge.

## The gathering (no account) - Pencil's table pattern, as Trek uses it

- **Members are browsers.** An HttpOnly cookie `arrivals_k` (22 random
  characters, `Path` = the app's base, SameSite=Lax), minted on start or
  join; the gathering keeps only `sha256("arrivals member v1:" + key + ":" +
  gathering id)`, so one phone is unlinkable across gatherings.
- **One versioned document**; every change moves `v`. Phones poll every 5
  seconds **while the page is visible and a gathering is on screen**;
  `?since=v` answers `{same: true}`: one read.
- **One door for every change**: `POST /api/g/:id/act {action}` ->
  `Core.act(doc, mid, action, {now, id, today})` inside a transaction,
  which returns exactly the keys to set or delete (`trips.<id>`,
  `trips.<id>.status`, `.delay`, `.ride`). A delay tapped on two phones is
  `add`ed inside the transaction (+20 and +20 make +40). Twelve phones
  adding trips while others change statuses, delays and rides all land
  (tested). The example on the page runs the same function.
- **Anyone in the gathering may add, edit, update or remove any trip** - the
  point is that Mom can add Grandpa's train and a cousin can mark him
  landed. **The host** alone changes the name, dates or zone, removes a
  member, or deletes the gathering. A member can leave (and rejoin their
  seat with the code). A removed or departed driver's rides read "needs a
  ride" again; their trips stay on the board.
- **Before joining**, a code shows only the gathering's name, the place,
  the dates, who started it and how many are in.
- **The same 404, word for word**, for an unknown id, a malformed one, one
  that expired and one that is not yours.
- **Expiry on read: 14 days** after the gathering's last day or its latest
  trip, whichever is later (`Core.expired`), by id or by code. There is no
  timer, so a gathering nobody ever opens again stays until someone does;
  the host can delete it at once.

### Privacy

No phone number and no email address is collected from anyone in a
gathering, and that is held in code: every text field of a gathering and a
trip passes `Core.refuse`, which refuses an @ of any width, a link, seven
digits in a row in any script, and markup - refused with a reason, not
tidied. Names are first names. The store holds gatherings and the
accounts' lists, and nothing else (tested: no browser key, no account id,
no email, no confirmation).

### Limits (per instance, in memory: they slow a script, they do not stop a determined one)

40 people and 120 trips a gathering (refused, never cut); 10 new gatherings
and 40 new members per address an hour; 30 distinct wrong codes or ids per
address in 15 minutes, then even the right one waits (the same dead id
polled over and over counts once); 900 writes per address and 150 per
member in 10 minutes; bodies 16 KB (the metered route 9 MB, after its
gates). IPv6 counts by its /64.

## Signed in (free): the other phone

`POST /api/g/:id/keep` writes `members.<mid>.owner` = an HMAC of the account
id AND the gathering id ("arrivals seat v1" - different in every gathering)
and adds the gathering to `mine/<tag>` (`{g: {<id>: {title, place, from,
to, at}}}`, the tag an HMAC of the account id, "arrivals owner v1"; 30
kept). A signed-in request with no key cookie is then the same member, on
any phone. The page does this by itself after sign-in, on start and on
open. Never the account id or the email in Arrivals' own store; the tag is
never sent to a phone.

## The AI: one call, behind the usual gates

`POST /api/read`: `identity.requireUser`, `requireBudget`, `requireDailyCap`
-> the 9 MB parser -> `ai.brief` (a 400 here costs nothing: text OR one
image, the gathering's own details, the image sniffed by its bytes) -> the
lab's guard (`global.LAB_AI_GUARD.allow({provider: 'claude', req, app:
'arrivals'})`; a no is its message plus "Typing the trip in still works.")
-> ONE `messages.create` with the forced tool `record_trips` -> the guard's
`record` with `priceUsd` in a `finally` (not for a member's own key). Free
tier Haiku, members Sonnet, by `identity.planFor`, like every sibling.
Claude only: there is no Gemini path and no `ARRIVALS_AI_PROVIDER`.

- **Drafts, never saves.** The answer is up to four drafts (`{dir, who,
  mode, from, carrier, number, hub, local, tz, party}`) the page puts in
  the form under "Filled in from your confirmation. Check every field."
- **Nothing of the confirmation is kept or logged**, and what must not come
  back cannot: the tool has no field for a booking reference, the prompt
  forbids them, only known fields are read, and `Core.cleanDraft` blanks
  any string with an @, a link, seven digits or markup, and any time
  outside the gathering's dates.
- A provider's own words never reach the page (502, or 503 when busy).
- The stand-in (`ARRIVALS_FAKE_AI`) reads "Flight UA 1482 / Arrives ORD
  2026-11-25 15:10 / from Denver / Passenger Ana" and answers an image with
  one fixed flight; triggers BLANK, INJECT, ROUNDTRIP, MAXTOKENS,
  UPSTREAMnnn.
- **Not built:** a model-written "plan for tomorrow". The day's plan is
  rules, so it is free, instant and the same on every phone.

## The look

The lab's house style (the HOA Desk rules; `public/app.css` opens with
them): a pure white page (true black in the dark theme), hairlines, system
fonts, one accent - a dusk violet, `#6a46c9` where it carries text on white
(`#b9a3ff` in the dark theme), the lab card's `#8660d6` as the brand dot.
Status colours only for status, always beside a word. On phones a floating
pill (Board, Pickups, Group; a badge counts what is open); from 900px the
same three in the header. Sheets are bottom sheets on phones and dialogs
from 900px. Motion only inside `prefers-reduced-motion: no-preference`. No
style attribute anywhere: a person's colour is a class (`.c0`-`.c9`).
`desktop.css` is not used and not synced here.

Rendered in headless Chrome over the DevTools Protocol (2026-11-25) at 390,
320 and 1280 px, light and dark - the home page, the board, a trip's sheet,
the add form, a draft from a confirmation, pickups before and after
claiming, the group page: no console error or CSP violation, nothing
sideways, every target 44 px or more.

## On the phone

`arrivals-list-v1` (the gatherings this phone opened: id, title, place,
dates) and `arrivals-prefs-v1` (first name, the gathering on screen, the
tab), in localStorage through `public/arrivals-store.js` only; every access
wrapped, memory as the fallback. The key that makes this browser a member
is the HttpOnly cookie, which the page cannot read.

## The decisions that matter

- **One rules file, run three times.** `public/arrivals-core.js` is UMD
  (`window.ArrivalsCore`, `require` on the server and in the tests). **No
  clock and no dice** (tested): "now" and every new id are handed in.
- **The instant is the server's**; the phone's own zone never enters the
  board.
- **No stored totals or lists**: the board, the issues and the runs are
  worked out from the trips on every draw.
- Queries are single-field equality (`code ==`), so **no composite index**.

## Local run and tests

```
npm run dev     # memory store + stand-in model, at http://localhost:8183/arrivals/
npm test        # the rules first, then end to end over HTTP under an /arrivals mount
```

`ARRIVALS_MEMORY=1` and `ARRIVALS_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`). `ARRIVALS_COLLECTION_PREFIX` (`arrivals_` from the lab host)
prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0` like every lab app.

`test/run.js` (37 tests): time zones (both coasts, half- and quarter-hour
zones, the date line, the spring gap and the autumn repeat in both
hemispheres, junk refused); days; a gathering's details; a trip; statuses;
the one door; the board; who needs a ride; clashes at 89 and 90 minutes;
two places at 60 and 61; the same place; runs at 45 and 46 minutes; a
driver's runs; what a phone is shown and the 14-day expiry; the day's plan;
the example; text and codes; storage; contrast in both themes and the lab
card; the page's promises; the copy and the shared files; the local
switches; and over HTTP: signed out, cross-site writes, starting and
joining, the board, phones at once, leaving and removing, the same 404 and
expiry, the limiters, hostile input, the account on a second phone, the
confirmation read, what the model sends back, the gates and the guard, and
what the store holds.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/passkey-client.js`, `verify-banner.js`)
are synced copies - edit them in `eriks-projects/shared/` (and
`eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, the page. No account:
`POST /api/gatherings`, `GET|POST /api/join/:code`, `GET /api/g/:id`
(`?since=v`), `POST /api/g/:id/act`, `DELETE /api/g/:id/members/:mid`,
`DELETE /api/g/:id/me`, `DELETE /api/g/:id`. Signed in: `GET /api/mine`,
`POST /api/g/:id/keep`, `DELETE /api/mine/:id`. Signed in and metered:
`POST /api/read`. The shared account at `/api/auth`.

## What is deliberately not built

- **A flight tracker** (see above), push notifications (the lab has no
  push), drive times or "leave by" (no maps key), seat counts.
- **A second model call**; **offline mode** (a live board needs the
  network; the page says "You're offline" and shows the last board).
- **Per-trip permissions**: a gathering is people who trust each other.

## Security

- A script CSP on every page; no inline `<script>`, `on*=` or `style=`;
  clicks by one `data-act` listener.
- Writes come from this page: every non-GET `/api/*` outside the shared
  account refuses `Sec-Fetch-Site` other than same-origin/none (403), an
  `Origin` naming another host (403) and a body that is not JSON (415).
- Every name is untrusted: cleaned in the core and escaped on render.
- `Referrer-Policy: no-referrer` and `noindex` on the gathering APIs; codes
  travel in fragments only.
- Only the app's own errors reach the page in their words.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
