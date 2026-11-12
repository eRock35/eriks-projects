# For Claude: Pencil

Keep score at game night - every game, every round, and who's ahead all
year. For families and friend groups who play cards, dice, darts, bowling or
mini golf - especially the game nights of Thanksgiving week and the
holidays.

- **It knows the games.** Seven scoring engines, each tested against
  hand-worked cases:
  - **Any game** - players or teams (2-12), highest or lowest wins, ending
    at a target score, after N rounds, or when the table says so; negative
    scores allowed. Presets of it: **Rummy** (highest, first to 500),
    **Card golf** (lowest after nine), **Euchre** (two teams with partners
    opposite, first to 10, the other team's blank filled with 0 because
    only one team scores a hand) and **Word game** (a score a turn, highest
    wins).
  - **Five dice** - the 13-box sheet per player: ones to sixes (35 at 63 or
    more, with "18 to go for +35 · 4 ahead of pace" and "No bonus this
    game" once it can't be reached), three and four of a kind (all dice),
    full house 25, small 30, large 40, five of a kind 50, chance; the extra
    five of a kind +100 each (a setting), with the joker scoring a full
    house or straight in full. Tap the five dice faces and every open box
    shows what it would score; tap a box to score it. Typing refuses an
    impossible score ("Twos can only be 0, 2, 4, 6, 8 or 10.").
  - **Bowling** - ten frames, X / and - marks, strike and spare bonuses
    waiting for their balls, the tenth frame's two or three balls, running
    totals, "can reach 256". The pin keypad offers exactly the pins still
    standing (tested over every reachable state).
  - **Darts 501 / 301 / 701** - a turn is 0-180 and must be something three
    darts can make (179, 178, 176, 175, 173, 172, 169, 166 and 163 can't);
    bust below zero, on 1 or on zero without a double (double-out on, it
    asks "Was the last dart a double?"); checkout suggestions from 170 down,
    found by search (fewest darts, the friendliest finishing double, the
    biggest first dart) - "T20 T20 Bull"; 159, 162, 163, 165, 166, 168 and
    169 have none and say so; points per three-dart turn.
  - **Hearts** - 3-6 players; each hand checked against 26 (a warning, not
    a refusal - misdeals happen); shoot the moon in one tap, +26 to everyone
    else or -26 for the shooter (a setting); passing left, right, across,
    keep; the game ends when anyone reaches 100 (a setting); lowest wins; a
    tie at the bottom keeps playing until it breaks, or is shared (a
    setting).
  - **Cribbage** - 2-3 players or two teams of two, to 121; each hand as
    pegging + hands + the dealer's crib, the deal alternating; counted in
    the order the game is - pegging, the hands from the dealer's left with
    the dealer last, then the crib - so the first to 121 wins on the spot
    and what is counted after never happened; no five cards make 19, 25,
    26 or 27 and the sheet says so; a drawn peg board (front peg and back
    peg); skunk under 91 and double skunk under 61 called at the end.
  - **Mini golf** - 9 or 18 holes, par per hole if the course shows it,
    strokes 1 to a limit (6 by default), "+3", "E", "-1", lowest wins.
- **Scoring is phone-first and one-handed.** Players down the side (held
  still), rounds across, the grid scrolling in its own box; tap a cell for
  a big keypad sheet (+/-, the game's quick numbers, "Save · next: Bo"), the
  leader crowned in words as well as a colour, the dealer marked and moved
  round, undo and redo of every change (60 steps, a finish included), round
  notes, rename, reorder, take out a player with no scores, and a **late
  player** who sits out the rounds already played and starts at last
  place's score (or zero - a setting); five dice, bowling, darts and mini
  golf give them a fresh sheet. Every game survives a reload.
- **The end.** The winner by the game's rule, a tie said plainly ("Bo and
  Cy tie for the win on 42."), skunks called, a podium, the best moments
  ("Priya shot the moon twice", "Marcus threw a turkey", "Noor checked out
  121"), confetti only without reduced motion, a **recap card** and a
  rematch.
- **The recap card** (1080 x 1350) is drawn on a canvas on the phone: the
  game, the date, the headline, up to eight standings ("+3 more"), a line
  of what it was ("3 rounds · to 500 · 3 players"), the best moment, and
  the address. Two taps - draw, then share - because iOS wants a fresh
  gesture for the share sheet; shared as a file through `navigator.share`
  where it can, else downloaded. **Never a link, never uploaded.** Names
  are drawn as initials in coloured circles, not emoji, because not every
  canvas has an emoji font. The text-fitting helpers (`fitText`,
  `wrapText`, `recapData`) are pure and tested.
- **Our table.** Every finished game leaves a summary in the history.
  Wins, win rate and the current streak per person per game ("🔥 Priya has
  won 3 Hearts games in a row") and across every game; the record for each
  game and who holds it - best Five dice and Bowling games, highest Darts
  checkout, lowest Hearts game, best Cribbage hand, best Mini golf round
  (per 9 or 18), best score in a game of your own - and "Next to beat:
  Marcus's 287 in Bowling"; head to head between any two people ("Priya 4 -
  2 Ines", per game too); every game, newest first. **Groups** ("Family",
  "Thursday crew") start a game in one tap and give their own table.
  A tie is not a win and breaks a streak; a game played alone counts for
  records, never for wins.
- **Show the table** - live, no accounts (below).
- **Read a paper score sheet** - the one metered thing (below).
- **Try a game night**: the Larkfield-Osei family and friends (Priya,
  Marcus, Noor, Kai, Ines, Theo - all invented) mid-way through a night:
  Hearts seven hands in where one more moon shot by Priya ends it, Bowling
  in frame 7 after Marcus's turkey, Darts with Noor on 121 (a three-dart
  checkout), Cribbage on the board, a finished Five dice game, and two
  months of Friday nights behind them so the table has stories. Every tap
  works, nothing is saved, a ribbon says so.

Built 2026-11-10 as an **everyday** drop: Muster (2026-11-09) was a business
one, so today was the other kind. **Staging only**: no custom domain until
Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/pencil`,
served at `challenge.strongtechnicalconsulting.com/pencil/`, data in
`pencil_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Every game box has the same stub of pencil and a score sheet torn off a
pad. Somebody adds a column wrong and the argument is about the maths, not
the game; somebody shoots the moon and nobody remembers whether that is +26
for everyone else or -26; nobody knows what a full house is worth in the
dice game, or how a spare in the tenth frame scores; and by the next game
night nobody remembers who won the last one. A scorekeeper that knows each
game's scoring, settles the arithmetic and keeps the bragging rights
across nights is something people use the same evening - and show the
table, which is how it spreads.

**Not a repeat:** Inside Joke is trivia from a group's photos and chat,
Flight is blind tastings and beer games, Pickup is teams and court money
for a rec game, Chorus splits chores. Nothing in the lab or the portfolio
keeps score for a game.

**No trademarked game names, anywhere** - "Five dice", "Word game",
"Hearts", "Cribbage", "Rummy", "Darts 501", "Bowling", "Mini golf", "Card
golf", "Euchre" are the names of games, not anybody's brand. The suite
fails if a brand name appears in any source file.

**Who pays.** Almost nobody. Every engine, the history, the stats, the
recap card, the CSV and showing the table are free, need no account and
make no model call. A **free** account adds one metered thing: reading a
paper score sheet (Haiku free, Sonnet for members via
`identityLib.planFor`), about a cent.

**How it becomes an iPhone app.** A widget with tonight's leader and "Next
to beat"; a Live Activity on the Lock Screen while a game runs ("Hearts ·
Priya leads 30 · Kai deals"); a SharePlay-like table view on everyone's
phone (the web app's Show the table, with no code); the share sheet taking
the recap card; Live Text to read a score sheet without AI.

## The decisions that matter

- **One rules file, run three times.** `public/pencil-core.js` is UMD
  (`window.PencilCore` in the page, `require` in the server and tests):
  text cleaning, ids and codes, the catalogue, the seven engines, results
  and standings, undo and redo (`change`/`undo`/`redo`), the table (late
  players, rename, reorder, the dealer, notes), highlights, summaries and
  stats, the CSV and JSON, the one door (`cleanGame`), what a table holds
  (`shareGame`, `tableView`), the sheet reader's request and answer and
  `applySheet`, the recap card's words, and the made-up night. **No clock
  and no dice** (tested): "now" and every new id are handed in; the
  made-up night uses its own fixed sequence and is the same every time.
- **Every change goes through `change(game, fn, o)`**: `fn` changes a copy
  (and may throw - a refusal leaves the game as it was), the old state
  (sides, data, dealer, status) goes onto the undo stack, redo is cleared,
  and `settle` marks the game finished - or playing again after an undo.
  Nothing changed means no undo step.
- **A side is a column of the sheet**: one player, or a team of up to four.
  Seats run A1, B1, A2, B2, so partners sit opposite and the deal moves one
  seat a round. People carry an id; a game keeps their names and emoji so
  it reads on any phone.
- **`cleanGame` is the one door**: every game read back from localStorage,
  a file or the server is rebuilt field by field - unknown fields dropped,
  every score re-checked by its engine (a Five dice box must be a score the
  box can hold, bowling rolls are replayed and cut at the first impossible
  ball, darts turns are replayed so a stored bust or finish is the rules'
  to say), bounded (12 sides, 200 rounds, names 20 characters, notes 120).
- **Emoji come from a fixed set of 24**: a person picks one, nobody types
  one, so nothing odd reaches a page through an emoji.
- **Highest checkout / best game** are records only from a side of one
  person: a team's score is not anyone's personal best.
- **Neutral copy**: they and them (tested over every string and this file).

## Show the table (no account)

The scorer taps Show and types a first name. The page sends the game -
`shareGame`: its name, the players' first names and emoji, the scores; no
undo stack, no group, no history - and gets a six-character code (no I, O,
0 or 1), its QR (Chapter's encoder) and "Send the link" (`#join=<code>` in
the fragment, never sent to a server or a Referer).

- **Watchers** join with the code and a first name ("Noor"; a name already
  there gets a number) and see the scoreboard on their own phone - the same
  views, read-only - polling every 4 seconds while the page is visible and
  the game is on screen (`?since=v&m=mv` answers `{same: true}` when
  nothing moved: one read). **No server timers.** A watcher can leave.
- **Only whoever holds the pencil writes.** Every write is the whole game
  plus the version it was based on; a stale one is a **409** with the table
  as it is, and the phone shows the latest. Someone joining moves `mv` (who
  is at the table), not `v` (the game), so a watcher arriving never makes
  the scorer's next write stale.
- **Hand the pencil**: the scorer picks a watcher; the roles swap in one
  transaction, both versions move, and the old scorer's next write is
  refused. The new scorer's phone takes over on its next poll ("You have
  the pencil now - you keep score."). It can go back.
- The scorer removes a watcher (they get the stranger's 404) and stops
  sharing (the table is deleted; the game stays on the scorer's phone).
- **Members are browsers.** An HttpOnly cookie `pencil_k` (22 random
  characters, `Path` = the app's base, SameSite=Lax), minted on share or
  join; the table keeps only `sha256("pencil member v1:" + key + table
  id)` per member, so one phone is unlinkable across tables.
- **A game first seen through a table** is kept on the watcher's phone
  under the scorer's game id (so the pencil can go back and forth) and
  marked `foreign`; when it finishes, its summary goes into this phone's
  history with its people matched to this phone's by name.
- **Expiry on read**: a table with no change and no join for **24 hours**
  is deleted by the read that finds it. Watching alone does not keep it.
- **The same 404, word for word**, for an unknown id, a malformed one, one
  that expired and one that is not yours.
- **What a code opens** before joining: the game's name, who keeps score,
  how many play and watch - no name at the table, no score.
- Offline, a watcher sees "You're offline - this is the table as of 3:42
  PM. Live updates need the network."; a scorer keeps scoring and the game
  goes to the table when the network is back (a 409 then shows the latest).

### Limits (per instance, in memory: they slow a script, they do not stop a determined one)

`lib/tables.js` LIMITS and `Core.LIMITS`: 20 watchers a table, 12 players,
200 rounds, hands or turns (refused with a 400, never cut), names 20
characters, notes 120, a 96 KB body; 10 shared tables per address an hour;
30 new watchers per address an hour; **30 distinct wrong codes or ids per
address in 15 minutes, then even the right one waits** (a phone polling the
same dead id counts once); 900 writes per address and 400 per member in 10
minutes. IPv6 counts by its /64.

## The model call (metered, signed in only)

**`POST /api/ai/sheet`**: `requireUser, requireBudget, requireDailyCap`
**then** the route's own 1.4 MB parser (401 / 402 / 403 / 503 before it,
never 413 - tested), then `ai.brief`: exactly `{image: {type, data}}`, a
JPEG or PNG **by its bytes**, at most 1 MB and 1600 px a side, its metadata
stripped again (`lib/image.js`, Whichbox's) - a 400 costs nothing. Then one
forced tool `record_score_sheet` through one call site (`ai.ask`), told the
photo and one fixed sentence - nothing about the game or the person
(tested by reading the fake's log). Then `cleanAiAnswer`: at most 12
columns and 60 rows, every cell a whole number from -9999 to 99999 or
blank, all-blank rows dropped, names as written (letters only, 20
characters, no links or markup), confidences from high / medium / low;
nothing usable is a 422.

Nothing is stored. The sheet says what is sent before the tap ("this one
photo, shrunk on this phone with its location removed. Nothing else - not
this game, the players' names or your history"), labels the answer
"AI-written - check every number against the paper", lets every number be
edited, matches each column to a player (by name, else by order; or "Leave
out"), and adds the rows only on a tap - through `applySheet`, which runs
every number through the game's own rules (Any game, Hearts - every player
needed - Mini golf and Darts; a finished leg ends the sheet). From the
Games page a sheet can start a new Any game, its names becoming players.
Signed out it explains and offers a free account; Try it says it is for
your own sheets; 401 opens sign-in, 402 the credit sheet, 403
`verify-email` its sentence and "Send the link again"; sheets size
themselves below the confirm-your-email banner.

## On the phone

`pencil-games-v1` (games in progress and recent finished ones whole, the
current one; old finished games drop their undo steps), `pencil-book-v1`
(people, groups, the history as summaries - up to 1,000 games),
`pencil-prefs-v1` (the first name last used) in localStorage. Every access
wrapped in try/catch; without storage the page works in memory and says
once that nothing will be kept. A locale Intl refuses ("en-US@posix")
falls back to en-US.

**Export and import**: the history as a CSV (one row per person per game,
formula-safe: a leading = + - @ is defused with a quote and restored on the
way back in) or as JSON (people, groups, history). Import merges by game
id (a game already here is skipped) and matches people by id, then by
name.

## Offline

The service worker (`sw.js`, network first, `pencil-shell-v1`) keeps the
app's own files, so a game on this phone works fully offline - every
engine, the history, the stats, the recap card, the CSV. It **never**
answers `api/`, and only clears its own `pencil-*` caches.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8164/pencil/
npm test        # the rules first, then end to end over HTTP under a /pencil mount
```

`PENCIL_MEMORY=1` and `PENCIL_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `PENCIL_COLLECTION_PREFIX`
(`pencil_` from the lab host) prefixes every collection. `npm test` runs
with `REQUIRE_VERIFIED_FOR_FREE_AI=0` (the gate itself is held by the
suite's gate test and by the lab's). The fake refuses a call that does not
force a tool, keeps every request (`fakeClient.calls`), answers with a
made-up rummy sheet (Wren, Odile, Jules), and takes `fakeClient.mode` for
one call: `blank`, `inject`, `maxtokens`, `upstreamNNN`.

`test/run.js` (34 tests): text and hostile input; codes; every engine
against hand-worked cases (Any game high and low, target, rounds and open,
Euchre's teams and zero fill, the dealer; Five dice every box, the
impossible, the 63 bonus and its pace, the joker and the extra 100;
Bowling's 300, all spares with a tenth-frame strike, the gutter game, the
Dutch 200, a worked 167, the tenth frame, and the pin keypad over every
reachable state; Darts' busts with and without double-out, the question at
zero, every checkout from 2 to 170 adding up and ending on a double, the
seven with none; Hearts' 26, both moon rules, 100, the tie kept and
shared; Cribbage's counting order, the impossible hands, skunks, teams;
Mini golf's par and limit); undo and redo; late players and the table;
history and stats (wins, rates, streaks, ties, records, head to head,
groups, solo games); the CSV and JSON; the one door; a table's view; the
recap card's words; the sheet reader's request, answer and `applySheet`;
the made-up night's planted states; contrast in both themes plus every
literal colour and the lab card; 44 px targets and the bigger keypad; the
page's promises (relative URLs, no inline script, the banner, wrapped
storage, every received string escaped, only the listed API paths, what
the reader and the share sheet say, confetti only with motion, polling
only while visible, the offline line, the service worker); neutral copy,
no brand names, no invisible characters or key-shaped strings, no real
person; the local switches; single-field queries; and over HTTP: signed
out with zero model calls and a 401 before the reader's parser, cross-site
writes refused, the gate order and the pencil check before the game
parser, showing and joining with the key cookie and its per-table hash,
only the scorer writing (a stale version refused, a join not making the
scorer stale, limits refused not cut), handing the pencil, removing,
leaving and stopping, the same 404 and expiry on read, the limits, hostile
input end to end, the reader over HTTP (bytes, EXIF, injection, 422, 502,
503), the 403 / 402 / 503 gates, and nothing identifying in the store.

Rendered with Playwright at 390 px and 1280 px, light and dark: the first
run, Try a game night (Hearts with the moon-shot button, Bowling in frame
7, Darts with the checkout, Cribbage's peg board, the finished Five dice
game, a Five dice rematch mid-game with the dice picker), Our table,
starting a Rummy game from scratch, the keypad, the winner with confetti
and the recap card (saved as a PNG), recent players one tap away, showing
the table and its invite, a watcher joining in a second browser and seeing
a Hearts hand land, handing the pencil and the new scorer's moon shot
landing on the old scorer's phone, the reader signed out, signed in (and
the verify-email 403), its proposal matched to players and added, the lab
card on the landing page and the app under the lab host. No console error
or CSP violation, nothing scrolling sideways. Then a hostile pass (markup,
bidi and zero-width characters, very long names, a 7-digit number, a
hostile CSV and a hostile watcher through the page): no dialog, no
injected element, no bidi character on the page. Found on the way: the
hero grid overflowed at 390 px, the podium's names were white on a light
row, the Five dice sheet's labels pushed the current player's column off
screen (now narrower, and it scrolls to the player), tapping another
player's box with dice in hand opened the typing keypad (now it scores
there), the tool bar took three rows on a phone (now one row of five), a
"biggest round" highlight named one player when three tied, and the file
writer turned `\u` escapes into literal invisible characters in three
files (the suite catches it).

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`). `public/qr.js` is
Chapter's copy of the vendored Kazuhiko Arase MIT "QRCode for JavaScript",
global renamed `PencilQR`. `lib/image.js` is Whichbox's.

## Data (Firestore: `pencil_*` in the lab database `challenge`)

Only shared tables are ever on the server.

- `tables/<id>` (16 random base64url characters) - `{code, game
  (shareGame), v, mv, members: {<mid>: {name, role: scorer|watcher,
  keyHash, joinedAt, at}}, createdAt, updatedAt}`.

No email, no account id, no browser key, no photo anywhere (tested over the
whole store). Queries are single-field equality (`code ==`), so **no
composite index**.

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, the page, `sw.js`. No
account: `POST /api/tables`, `GET|POST /api/join/:code`. Members
(`/api/t/:id`): `GET` (`?since=v&m=mv`), `DELETE me`. The pencil: `PUT
game` (`{game, v}`), `POST pencil` (`{to}`), `DELETE members/:mid`,
`DELETE /api/t/:id`. Metered: `POST /api/ai/sheet`. The shared account at
`/api/auth`.

## What is deliberately not built

- **Several scorers at once** (one document per round): the brief allowed
  it, but a scorekeeper is one person with the pencil; one versioned
  document with a 409 is simpler and cannot lose a write. Handing the
  pencil covers "you keep score for a bit".
- **Delta polling**: a changed table is re-read whole - a game is a few KB.
- **Legs and sets in darts**, **a 61-point cribbage game**, **Bowling
  splits and fouls** as marks: rarer than they are complicated.
- **An account-backed history**: an account is only for the reader, and
  the brief kept it that way. Export and import move a history between
  phones.
- **Notifications** ("Priya shot the moon!"): no sender on this platform.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the reader's gates run
  before its parser; a new table's address limits and a write's pencil
  check run before the 96 KB game parser; every other route keeps a 16 KB
  limit.
- Writes come from this page: every non-GET `/api/*` outside the shared
  account refuses `Sec-Fetch-Site` other than same-origin/none (403), an
  `Origin` naming another host (403) and a body that is not JSON (415).
- Every name, game name, note, watcher and model answer is untrusted:
  cleaned in the core (no markup, bidi or invisible characters, bounded;
  names letters only) and escaped on render (the test cuts out every
  `esc(...)` and fails on a field concatenated into markup); the recap card
  is drawn with `fillText`, which reads no markup; the QR's label is
  stripped of markup.
- `Referrer-Policy: no-referrer` and `noindex` on the table APIs; codes
  travel in fragments only.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy").
  Nothing logged carries a body, a photo or anyone's scores.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
