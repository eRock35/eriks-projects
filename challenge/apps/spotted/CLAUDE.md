# For Claude: Spotted

The license plate game for the whole car - every phone playing, first to
spot it scores. For families and friends on a road trip.

**This is a rebuild of the 2026-11-12 drop**, which was lost with its build
container before it was pushed (see `challenge/CLAUDE.md`, "Rebuilding the
lost drops"). Its brief and code did not survive; this was built fresh on
2026-11-22 from the reconstructed spec in the repo-root `HANDOFF.md`
("Spotted - everyday"), as drop #65. The name, tagline, audience, emoji and
original colours are the 2026-11-12 drop's; the lab card's colours were
nudged (see `lab.js`). Thanksgiving week is the year's biggest drive.

- **The board**: the 50 states and DC, each a little license plate with
  its rarity and points, A-Z, rarest first or still to find, and a search
  ("oh", "Ohio", "new" all work). Tap a plate to spot it; tap a spotted one
  to see who and when, and take it back if allowed.
- **A car game** anyone joins with a six-character code (no I, O, 0 or 1)
  and a first name - no account. Pencil's table pattern (below), except
  every phone writes.
- **First tap wins.** The first tap on a plate to reach the server scores
  it, inside a transaction; the second phone hears "Rosa spotted Ohio
  first." Never two winners (tested with twelve phones tapping at once).
- **Rarer plates score more** (the rule is below), or "Every plate 1
  point" if whoever starts the game prefers.
- **A live scoreboard**: ranked by points, a tie sharing a place and said
  plainly ("Rosa and Mae are tied on 5 points."), "Leads"/"Wins" in words,
  each player's colour and initials.
- **A drawn US map filling in**: a tile map (one rounded square per state,
  near where it sits, on the familiar 11 x 8 grid), drawn in SVG by the page
  from `SpottedCore.STATES` - no tile service, no map data to license. Each
  tile takes the colour of whoever spotted it; codes are drawn on it, so
  colour is never the only signal.
- **Play on this phone**: a trip that never leaves the phone and works
  offline. Add everyone in the car and pass the phone - each plate asks
  "Who spotted it?". The same scoring, map and recap.
- **Trip history on the phone**: every trip (solo or a car game, kept up to
  date while it runs so a game that closes after a quiet day is still
  there), each with its map, scoreboard and best moments, and **a lifetime
  map** of every plate this phone has ever seen. Rename or remove a trip.
- **A recap card** (1080 x 1350) drawn on a canvas on the phone: the trip,
  the date, the headline, the map in players' colours, the line ("22 of 51
  plates · 41 points · 4 players"), up to four standings ("+N more"), the
  best moment and the address. Two taps - draw, then share - because iOS
  wants a fresh gesture for the share sheet; shared as a **file** through
  `navigator.share` where it can, else downloaded. Never a link, never
  uploaded. Names are initials in coloured circles, not emoji.
- **Try the example**: the Vance-Okoro family (Junie, Theo, Rosa, Ben - all
  invented) on the drive to Gran's the day before Thanksgiving, 22 plates
  in, and three trips before it. A five-step guided tour: the board; tap
  Vermont (Rare, 5 points - Junie takes the lead); tap Ohio and Theo's
  scripted phone gets there first; the trips and lifetime map; the recap
  card. Every tap works, nothing is kept or sent, a ribbon says so.

**No AI.** There is no model call anywhere: nothing here a model would do
better than the rules, and the spec says no AI on photos of other people's
cars - so no photo is ever taken, sent or read, of a car or anything else.
`SPOTTED_FAKE_AI` exists only because the lab host sets `<SLUG>_FAKE_AI=1`
for every app on a local run; like every sibling, it is refused on Cloud
Run. The shared identity is still mounted (sign-in keeps the trip history
on two phones, and the verify banner asks it), as in every lab app.

## The rarity rule (no data source; a fixed, documented tiering)

How often a plate turns up on an ordinary US road trip follows, roughly,
how many cars a state has, which follows how many people live there. So
the tiers are cut by population (rounded census scale, no live data), with
one exception: **Alaska and Hawaii are Rare whatever their size**, because
nobody drives a car onto the mainland from either.

| Tier | Points | States |
|---|---|---|
| Everywhere | 1 | the 14 biggest, about 7.4 million and up: CA TX FL NY PA IL OH GA NC MI NJ VA WA AZ |
| Common | 2 | the next 16, about 3.4 to 7.1 million: TN MA IN MO MD WI CO MN SC AL LA KY OR OK CT UT |
| Uncommon | 3 | the next 11, about 1.3 to 3.2 million: IA NV AR MS KS NM NE ID WV NH ME |
| Rare | 5 | the 8 smallest, all under about 1.2 million (MT RI DE SD ND DC VT WY), plus AK and HI |

The whole board is 14 + 32 + 33 + 50 = 129 points. A local twist (a plate
from your own state is no find) was considered and left out: it needs
everyone's home state, and a car game should start in one tap.

Not a repeat: Pencil keeps score for games you bring; Trek (a lost drop,
still to rebuild) moves a crew along a map by exercise. Nothing in the lab
plays a game on the road.

**Where it lives:** `challenge/apps/spotted`, served at
`challenge.strongtechnicalconsulting.com/spotted/`, data in `spotted_*`
collections of the lab's `challenge` database. See `challenge/CLAUDE.md`
for mounting, prefixes and graduation. Every browser URL is relative to
`BASE`; keep it that way.

## The car game (no account) - Pencil's table pattern

- **Start**: a first name, an optional trip name, the scoring. The phone
  gets the game, a code and an invite sheet ("Send the link":
  `#join=<code>` in the fragment, never sent to a server or a Referer).
- **Join**: the code (any case, a dash or not) and a first name; a name
  already in the car gets a number ("Rosa 2"). Before joining, a code shows
  only the trip's name, who started it and how many play - no other name,
  no score. The same browser joins once; one who left rejoins their seat.
- **Players are browsers.** An HttpOnly cookie `spotted_k` (22 random
  characters, `Path` = the app's base, SameSite=Lax), minted on start or
  join; the game keeps only `sha256("spotted member v1:" + key + ":" + game
  id)` per player, so one phone is unlinkable across games.
- **One versioned document** per game; every change (a plate, a take-back,
  a join, a leave, the end) moves `v`. Phones poll every 3 seconds **while
  the page is visible and the game is on screen**; `?since=v` answers
  `{same: true}` when nothing moved: one read. No server timers.
- **Take back**: the spotter within 5 minutes (a mis-tap); whoever started
  the game, any plate (settling an argument). The plate is open again.
- **The host** ends the game (scores final; every phone moves it into its
  trips on its next look and can still read it), removes a player (their
  plates open again - for a phone from the other car), or deletes it now.
  A player leaves (their points stay, marked "(left)").
- **Expiry on read**: a game with no change and no join for **24 hours** is
  deleted by the read that finds it, by id or by code. Polling alone does
  not keep it alive.
- **The same 404, word for word**, for an unknown id, a malformed one, one
  that expired and one that is not yours (or that you left).
- Offline, a player sees "You're offline - this is the board as of 3:42 PM.
  Taps need the network." and the plates are disabled until it is back.

### Limits (per instance, in memory: they slow a script, they do not stop a determined one)

`lib/games.js` LIMITS and `Core.LIMITS`: 12 players a car (refused, never
cut), names 20 characters, trip names 40, a 16 KB body; 10 new games per
address an hour; 30 new players per address an hour; **30 distinct wrong
codes or ids per address in 15 minutes, then even the right one waits** (a
phone polling the same dead id counts once); 900 writes per address and
300 per player in 10 minutes. IPv6 counts by its /64.

## Signed in (free): the trip history on two phones

`trips/<tag>` = `{owner, trips, updatedAt}`, the tag an HMAC of the account
id under a key derived from the session secret ("spotted owner v1") -
never the id or the email. Saved only against the version the phone last
saw; a stale phone gets 409 with the account's copy, merges it (each trip
by its own time; a removal is a tombstone and a change; a tie goes to the
larger copy by canonical text, so either side merges the same) and saves
again. Refused whole (400) for an unknown field anywhere, a string with an
@ (any width), a link, seven digits in a row in any script, markup, a name
that is not a first name, a plate that is not on the board, more than 300
trips or about 600 KB. 120 saves an account in 10 minutes. The live car
game's id is never synced.

## On the phone

`spotted-trips-v1` (the history, through `cleanTrips` on every read),
`spotted-now-v1` (the trip being played, and the car game's id with it -
not the key, which the page cannot read), `spotted-prefs-v1` (the first
name last used, the tour seen), `spotted-sync-v1`, in localStorage through
`public/spotted-store.js` only (the page touches no storage itself). Every
access wrapped; without storage it works in memory and says once that
nothing will be kept.

## Offline

`sw.js`, network first, `spotted-shell-v1`: the app's own files, so a trip
on this phone - board, map, history, recap - works fully offline. It never
answers `api/` and only clears its own `spotted-*` caches.

## The decisions that matter

- **One rules file, run three times.** `public/spotted-core.js` is UMD
  (`window.SpottedCore` in the page, `require` on the server and in the
  tests): the board, text, codes, scoring, trips, `gameView` (what a phone
  sees of a game - never a key hash), `tripFromGame`, the one door
  (`cleanTrips`), the merge, the lifetime map, the recap card's words and
  `fitText`. **No clock and no dice** (tested); the demo uses constants.
- **First tap wins in the store, not the page.** `transactKeys` adds
  `spots.XX` only if it is absent; the memory store queues transactions on
  a document so the test's twelve simultaneous taps see one winner (and a
  test shows an unqueued read-then-write would let the second overwrite).
  Firestore's transaction retries on contention to the same effect.
- **Points are worked out, not stored**: a spot holds who and when; the
  scoreboard is computed from the fixed rarity table.
- Queries are single-field equality (`code ==`), so **no composite index**.

## Local run and tests

```
npm run dev     # memory store, at http://localhost:8178/spotted/
npm test        # the rules first, then end to end over HTTP under a /spotted mount
```

`SPOTTED_MEMORY=1` and `SPOTTED_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `SPOTTED_COLLECTION_PREFIX` (`spotted_` from the
lab host) prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0` like every lab app (nothing here spends).

`test/run.js` (28 tests): the board and its tiers; text and hostile input;
codes; scoring, ties and highlights; a trip on one phone; the one door;
the two-phone merge and lifetime map; the game view; the recap card's
words; the demo's planted story; the storage module; contrast in both
themes, the twelve player colours, the hero and the lab card (20+ in CIE
Lab from every card, white text 4.5:1, drop #65); 44 px targets; the
page's promises (relative URLs, no inline script, the banner, storage only
through the module, no clock in the core, one BASE-relative fetch, only the
listed routes, polling only while visible, escaping, the recap as a file,
no camera or location); the copy and the shared files; the local switches
and prefix; and over HTTP: signed out, cross-site writes, starting and
joining with the key cookie and its per-game hash, first tap wins with
twelve phones at once, polling, taking back, ending/leaving/removing, the
same 404 and idle deletion, the wrong-code limiter, the limits, hostile
input end to end, sync, and nothing identifying in the store.

Rendered in headless Chrome (driven over CDP) at 390 and 1280 px, light
and dark: the first run, the example and every tour step, the race for
Ohio, the trips and lifetime map, the recap card, How it works, a
pass-the-phone trip (who spotted it, a spotted plate's sheet, the end),
and a two-browser car game: started in one, joined by link in the other,
both tapping Ohio at once (one "is yours", the other "Rosa spotted Ohio
first."), both scoreboards agreeing, then the host ending it. No CSP
violation, nothing sideways at 390 px, every target 44 px.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, the page, `sw.js`. No
account: `POST /api/games`, `GET|POST /api/join/:code`, `GET /api/g/:id`
(`?since=v`), `POST /api/g/:id/spots` (`{state}`), `DELETE
/api/g/:id/spots/:state`, `POST /api/g/:id/end`, `DELETE
/api/g/:id/players/:mid`, `DELETE /api/g/:id/me`, `DELETE /api/g/:id`.
Signed in: `GET|PUT|DELETE /api/sync`. The shared account at `/api/auth`.

## What is deliberately not built

- **Canadian provinces** (the spec's "optional"): they would need tiles on
  the map and their own rarity; the board is the 50 states and DC.
- **Photos of plates, or reading a plate with AI**: never - other people's
  cars.
- **Location** ("we're in Ohio now, so Ohio is worth less"): no location is
  ever asked for.
- **An account to play**: the account only carries the history.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- Writes come from this page: every non-GET `/api/*` outside the shared
  account refuses `Sec-Fetch-Site` other than same-origin/none (403), an
  `Origin` naming another host (403) and a body that is not JSON (415).
- Sync's 1 MB parser runs after the sign-in check; every other route 16 KB.
- Every name and trip name is untrusted: cleaned in the core and escaped
  on render; the recap card is drawn with `fillText`, which reads no markup.
- `Referrer-Policy: no-referrer` everywhere and `noindex` on the game APIs;
  codes travel in fragments only.
- Only the app's own errors reach the page in their words.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
