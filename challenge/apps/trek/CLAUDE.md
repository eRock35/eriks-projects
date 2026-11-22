# For Claude: Trek

A journey for your whole crew - every walk, run and ride moves you all
along the map. For friends, families, coworkers and walking groups.

**This is a rebuild of the 2026-11-14 drop**, which was lost with its build
container before it was pushed (see `challenge/CLAUDE.md`, "Rebuilding the
lost drops"). Its brief and code did not survive; this was built fresh on
2026-11-22 from the reconstructed spec in the repo-root `HANDOFF.md`
("Trek - everyday"), as drop #67. The name, tagline, audience, emoji and
original colours are the 2026-11-14 drop's; the lab card's colours were
nudged (see `lab.js`).

- **Six routes**, drawn by the page as stylised lines in SVG (a few points
  each in `TrekCore.ROUTES` - their general direction and bends, nothing
  traced, no tile service, no map data to license): Hadrian's Wall Path
  (135 km, a week-long office challenge), England's Coast to Coast (309),
  the Camino Francés (780), the Appalachian Trail (3,520), the Pacific
  Crest Trail (4,265) and Across America, New York to San Francisco
  (4,700). Real public names and rounded published lengths are facts; the
  checkpoints' names and postcards are invented and generic (what a stretch
  feels like - never a business, a person or a claim about a real place).
- **A crew** anyone joins with a six-character code and a first name - no
  account. Pencil's table pattern (below), as Spotted uses it, for a group
  that lives for weeks: up to 20 people.
- **Log it**: walk, run, ride, swim or roll (a wheelchair push), in minutes,
  km or miles, for today or up to six days back. One fair trail distance
  (the table below), worked out by the server from what was logged - a
  phone never sends a distance. The crew moves together along the line;
  a live preview says "= 2.4 km along the trail" before you log.
- **Checkpoints and postcards**: eight per route (10, 25, 40, 50, 65, 80,
  90 and 100 percent). Passing one opens its postcard; every postcard
  collected stays on the journey and on the trek.
- **A leaderboard that rewards showing up** (the rule below), a weekly
  streak per person, and a crew streak (weeks with everyone out).
- **The feed**: the newest logs ("Priya walked 30 min · Today · +2.4 km"),
  each with Undo for whoever logged it (and the host, for the "I typed 300
  instead of 30" fix).
- **Finished, then the next leg**: the log that reaches the end marks the
  crew finished; whoever started it picks the next route. The finished leg
  is kept as a line; each leg's leaderboard starts fresh. The route may also
  change before anyone has logged.
- **On this phone**: a trek that never leaves the phone and works offline.
  Alone, or the family on one phone (each log asks who). Same rules.
- **Trek history on the phone**: every trek (solo, or a crew's legs, kept up
  to date while it runs so a crew that closes after a quiet month is still
  there), the distance all told and the routes finished. Rename or remove.
- **A recap card** (1080 x 1350) drawn on a canvas on the phone: the crew,
  the date, the route drawn with the walked part, how far and what percent,
  days out and the crew streak, up to four standings ("+N more"), the latest
  postcard or a streak, and the address. Two taps (draw, then share),
  shared as a **file** through `navigator.share`, else downloaded. Never a
  link, never uploaded.
- **Try the example**: the Lunch Loop (Mara, Dev, Priya, Tomas, Ines - five
  invented coworkers) five weeks into the Camino, 1.9 km short of halfway.
  A five-step guided tour: the crew on the map; log a 30-minute walk and the
  halfway postcard arrives; the leaderboard (Priya, out nearly every day on
  short walks, leads; Tomas rode furthest on weekends and is fourth); the
  treks; the recap card. Every tap works, nothing is kept or sent.

**No AI.** There is no model call anywhere: nothing here a model would do
better than the rules. **No location, no GPS, no health-app import**:
people type what they did. `TREK_FAKE_AI` exists only because the lab host
sets `<SLUG>_FAKE_AI=1` for every app on a local run; like every sibling, it
is refused on Cloud Run. The shared identity is still mounted (sign-in keeps
the trek history on two phones, and the verify banner asks it).

## The conversion table: one fair trail distance

Effort per kilometre, roughly: the energy it takes to move one body one km.
Walking and running cost about the same per km (running is faster, not
costlier per km); cycling about a third of that; swimming about four
times. A wheelchair push counts as a walk. Minutes count at an easy pace
for each kind, times the same factor, so a minute logged and a km logged
agree for someone at that pace.

| kind | 1 km logged | 1 minute logged |
|---|---|---|
| walk | 1 trail km | 80 m (4.8 km/h) |
| roll | 1 trail km | 80 m (4.8 km/h) |
| run | 1 trail km | 160 m (9.6 km/h) |
| ride | 1/3 trail km | 100 m (18 km/h, a third) |
| swim | 4 trail km | 120 m (1.8 km/h, four times) |

Miles are 1.609344 km. Whole metres, rounded. One log: whole minutes 1 to
600, or 0.1 km up to 100 (walk, run, roll), 300 (ride) or 30 (swim); a
decimal comma is fine. A run per minute counts double a walk per minute,
on purpose: the pace is the effort. The rough factors are a choice for
fairness between friends, not physiology, and are said so on the page.

## The scoring rule: showing up counts as much as distance

- **Each person's trail distance counts up to 25 km a day** - for the
  leaderboard AND for how far the crew moves. A long day helps, but one
  person (or one 999 km joke) cannot carry the crew. What was logged is
  kept whole; only the count is capped.
- **Points**: 10 for every day you got out at all, 1 per capped trail km,
  and 15 for every week (Monday to Sunday) with 3 or more days out. A 2 km
  walk every day of a week scores 70 + 14 + 15 = 99; a single 25 km day,
  35. Ranked by points, then days out, then distance; equal points share a
  place, and the headline says a tie plainly.
- **Your weekly streak**: weeks in a row with 3+ days out. This week counts
  once made, and does not break the streak while it can still be made.
- **The crew streak**: weeks in a row when everyone in the crew got out at
  least once. People count from the week they joined; someone who left no
  longer counts.
- **Days are calendar dates, never instants.** A log carries the logger's
  own local date (`TrekCore.localDay(ms, getTimezoneOffset())`), so a
  Sunday-night walk in California is Sunday's although it is Monday in UTC,
  and every phone in the crew agrees on every week. The server accepts a day
  from its UTC date + 1 back to - 8 (today or six back, in UTC-12 to UTC+14).
  A member's `since` is their join date in UTC.

**Where it lives:** `challenge/apps/trek`, served at
`challenge.strongtechnicalconsulting.com/trek/`, data in `trek_*`
collections of the lab's `challenge` database. See `challenge/CLAUDE.md`.
Every browser URL is relative to `BASE`; keep it that way.

## The crew (no account) - Pencil's table pattern

- **Start**: a first name, an optional crew name, a route. The phone gets
  the crew, a code and an invite sheet ("Send the link": `#join=<code>` in
  the fragment, never sent to a server or a Referer).
- **Join**: the code (any case, a dash or not) and a first name; a name
  already in the crew gets a number ("Mara 2"). Before joining, a code shows
  only the crew's name, its route, who started it and how many are in - no
  other name, no distance. The same browser joins once; one who left
  rejoins their seat.
- **Members are browsers.** An HttpOnly cookie `trek_k` (22 random
  characters, `Path` = the app's base, SameSite=Lax), minted on start or
  join; the crew keeps only `sha256("trek member v1:" + key + ":" + crew
  id)` per member, so one phone is unlinkable across crews.
- **One versioned document** per crew; every change moves `v`. Phones poll
  every 4 seconds **while the page is visible and the crew is on screen**;
  `?since=v` answers `{same: true}` when nothing moved: one read.
- **Each log is its own key** (`logs.<lid>`), added in a transaction: twelve
  phones logging five times at once all land (tested), and there is no
  stored running total for two writes to race on - totals are worked out
  from the logs on every read (`crewView`). A phone sees each member's
  metres by day and the newest 60 logs, never every log.
- **The host** removes a member (their logs go - for someone added by
  mistake), takes back anyone's log, picks the next route, or deletes the
  crew. A member leaves (their distance stays, marked "(left)").
- **Expiry on read: 30 days idle.** A crew with no log, no join and no
  change for **30 days** is deleted by the read that finds it, by id or by
  code. A crew is a habit, so a day (Spotted's car game) would be far too
  short; a month of silence means the group has stopped, and nothing about
  it is kept. Polling alone does not keep it alive.
- **The same 404, word for word**, for an unknown id, a malformed one, one
  that expired and one that is not yours (or that you left).
- Offline, a member sees "You're offline - this is the crew as of 3:42 PM.
  Logging needs the network." and the log button waits.

### Limits (per instance, in memory: they slow a script, they do not stop a determined one)

`lib/crews.js` LIMITS and `Core.LIMITS`: 20 people a crew (refused, never
cut; twelve colours, then they repeat - initials tell people apart), names
20 characters, crew names 40, a 16 KB body; 3,000 logs a leg; 20 logs a
person a day; 10 new crews per address an hour; 30 new members per address
an hour; **30 distinct wrong codes or ids per address in 15 minutes, then
even the right one waits** (a phone polling the same dead id counts once);
900 writes per address and 120 per member in 10 minutes. IPv6 counts by its
/64.

## Signed in (free): the trek history on two phones

`treks/<tag>` = `{owner, treks, updatedAt}`, the tag an HMAC of the account
id under a key derived from the session secret ("trek owner v1") - never
the id or the email. Saved only against the version the phone last saw; a
stale phone gets 409 with the account's copy, merges it (each trek by its
own time; a removal is a tombstone and a change; a tie goes to the larger
copy by canonical text) and saves again. Refused whole (400) for an unknown
field anywhere, a string with an @ (any width), a link, seven digits in a
row in any script, markup, a name that is not a first name, a log out of
range, an unknown route, more than 100 treks or about 600 KB. A solo trek
keeps what was logged (never a distance: it is worked out again on every
read); a crew's leg keeps each person's metres by day. 120 saves an account
in 10 minutes. The live crew's id is never synced.

## On the phone

`trek-treks-v1` (the history, through `cleanTreks` on every read),
`trek-now-v1` (the trek on the go, and the crew's id with it - not the key,
which the page cannot read), `trek-prefs-v1` (first name, tour seen, km or
miles, the last kind logged), `trek-sync-v1`, in localStorage through
`public/trek-store.js` only. Every access wrapped; without storage it works
in memory and says once that nothing will be kept.

## Offline

`sw.js`, network first, `trek-shell-v1`: the app's own files, so a trek on
this phone works fully offline. It never answers `api/` and only clears its
own `trek-*` caches.

## The decisions that matter

- **One rules file, run three times.** `public/trek-core.js` is UMD
  (`window.TrekCore`, `require` on the server and in the tests): the
  routes, the conversion, days and weeks, scoring and streaks, progress and
  postcards, text, codes, `crewView` (never a key hash), `trekFromCrew`,
  the one door (`cleanTreks`), the merge and the recap card's words. **No
  clock and no dice** (tested); the demo uses constants.
- **The distance is the server's.** `toTrail(kind, unit, amt)` runs on the
  server for a crew; a body's `m` is ignored (tested).
- **No stored totals.** Progress, points and streaks are computed from the
  logs, so concurrent logs cannot lose distance and a removed log moves the
  crew back.
- Queries are single-field equality (`code ==`), so **no composite index**.

## Local run and tests

```
npm run dev     # memory store, at http://localhost:8179/trek/
npm test        # the rules first, then end to end over HTTP under a /trek mount
```

`TREK_MEMORY=1` and `TREK_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `TREK_COLLECTION_PREFIX` (`trek_` from the lab
host) prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0` like every lab app (nothing here spends).

`test/run.js` (34 tests): the routes; the conversion table and its limits;
days, weeks and time zones (California's Sunday night, Kiritimati's Monday
morning, the new year); scoring and the cap; streaks and the crew streak;
progress and postcards; text; codes; a trek on one phone; the one door; the
two-phone merge; the crew view; the recap card's words; the demo's planted
story; the storage module; contrast in both themes, the people's colours and
the lab card (20+ in CIE Lab from every card, white text 4.5:1, its emoji on
no other card, drop #67); 44 px targets; the page's promises (relative URLs,
no inline script, the banner, storage only through the module, no clock in
the core, one BASE-relative fetch, only the listed routes, polling only
while visible, escaping, the recap as a file, no location); the copy and
the shared files; the local switches and prefix; and over HTTP: signed out,
cross-site writes, starting and joining with the key cookie and its per-crew
hash, logging (the server's distance, days, limits, the cap), twelve phones
logging at once with nothing lost, finishing and the next leg, polling,
taking back, leaving and removing, the same 404 and 30-day idle deletion,
the wrong-code limiter, the limits, hostile input, sync, and nothing
identifying in the store.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, the page, `sw.js`. No
account: `POST /api/crews`, `GET|POST /api/join/:code`, `GET /api/c/:id`
(`?since=v`), `POST /api/c/:id/logs` (`{kind, unit, amt, day}`), `DELETE
/api/c/:id/logs/:lid`, `POST /api/c/:id/route`, `DELETE
/api/c/:id/members/:mid`, `DELETE /api/c/:id/me`, `DELETE /api/c/:id`.
Signed in: `GET|PUT|DELETE /api/sync`. The shared account at `/api/auth`.

## What is deliberately not built

- **GPS, location, step counters, health-app import**: never - the spec
  says no location tracking; people type what they did.
- **Streaks across legs**: each leg's leaderboard and streaks start fresh
  when the crew picks the next route (the logs are cleared with the leg).
- **Real maps or real places along the way**: the routes are drawn shapes
  and the postcards are generic, so nothing needs licensing or checking.
- **An account to walk**: the account only carries the history.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- Writes come from this page: every non-GET `/api/*` outside the shared
  account refuses `Sec-Fetch-Site` other than same-origin/none (403), an
  `Origin` naming another host (403) and a body that is not JSON (415).
- Sync's 1 MB parser runs after the sign-in check; every other route 16 KB.
- Every name is untrusted: cleaned in the core and escaped on render; the
  recap card is drawn with `fillText`, which reads no markup.
- `Referrer-Policy: no-referrer` everywhere and `noindex` on the crew APIs;
  codes travel in fragments only.
- Only the app's own errors reach the page in their words.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
