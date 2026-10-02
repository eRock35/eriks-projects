# For Claude: Flight

A beer crew's game night. **Blind-tasting showdowns** (everyone brings a
beer, it gets a shuffled letter, the crew scores it blind - stars, a style
guess, an ABV guess, tasting notes - then the reveal hands out awards),
**guess who brought it**, a **Same-Can Challenge** for a crew that is in
different cities, a **vote on the next brewery or crawl** (a pasted Hopscotch
crawl link becomes a crawl card), and a **crew leaderboard** with streaks and
palate profiles. Friends join by link, QR or a six-character code with a
name and an emoji - no account.

Built 2026-10-02 at Erik's request, the same day he asked for it: "an app to
share with my beer buddies on some fun stuff" (item 2 of "Queued by Erik
(2026-10-02)" in `challenge/CLAUDE.md`). An **everyday** drop.
**Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/flight`,
served at `challenge.strongtechnicalconsulting.com/flight/`, data in
`flight_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Erik travels a lot, and his beer friends are spread out. A tasting night is
the fun part of the hobby - arguing about whether that was a hazy or a West
Coast, who brought the dud - and it falls apart the moment the crew is not in
one room. So the brief was a group game that works **in the same bar and
from different cities**: the blind tasting for the table, the Same-Can
Challenge for when everyone is apart (one beer anyone can buy, or a local one
each, scored on your own time inside a window).

**Not Hopscotch.** Hopscotch (`eRock35/beer-app`) is a personal passport and
tasting journal with a brewery map and crawl planner. Flight has no journal,
no passport, no brewery map: it is a game a group plays. Where the two meet -
"where do we go next?" - Flight **reads** a Hopscotch crawl by its public
share link instead of planning crawls itself (see "Hopscotch links").

**Who pays.** Almost nobody. The example crew, crews, joining, tasting,
voting and the leaderboard are free and make no model call. A host needs a
**free** account (so the crew is theirs to run and delete); members need
**none**. The one metered thing is **Snap the label** (Haiku free, Sonnet
for members via `identity.planFor`), a cent or two, paid by whoever snaps.

## Responsible tone (Erik's bar, and ours)

Fun, not a drinking game. **No chugging, no quantity mechanics, no "most
drinks" award, nothing that counts how much anyone drank.** Points are for
palate (style guesses), ABV knowledge, reading your friends (who brought it)
and taste (awards). **Non-alcoholic beers are first-class**: an NA family in
the style list (NA lager, NA IPA, NA wheat, NA stout/porter), an NA beer in
the example's headline tasting, and an NA IPA counts as an IPA for Hop Head.
One quiet line in the footer, once: "Drink responsibly. 21+ where required."
`test/run.js` greps the page and the rules for drinking-game words.

## The decisions that matter

- **One rules file, run three times.** `public/flight-core.js` is UMD
  (`window.FlightCore` in the page, `require` in the server and tests):
  styles and families, cleaning, the session rules (add a beer, start,
  score, guess, reveal), results, awards, the recap, the per-viewer view,
  the leaderboard, polls. The server stores and masks; the page draws and
  plays the example crew with the very same functions; the tests check one
  file.
- **Everything is computed on read, deterministic.** Results, awards and the
  leaderboard are worked out from the stored scores on every read and never
  stored - so every phone sees the same numbers, a member who leaves takes
  their points with them, and deleting a session takes its points off the
  board. Stars are summed in half-units, ABV compared in tenths: no floats.
- **Blind means blind, server-side.** `sessionView()` is the only shape a
  member gets. Before the reveal nobody receives a beer's name, brewery,
  style, ABV or bringer unless they brought or added it, nor anyone else's
  scores or guesses - only how far along each person is ("Dev 2/3") and the
  set of people who brought something (the guessing game needs that).
- **Letters are shuffled at the start.** During setup each member adds their
  own beer from their own phone (two each, eight in all); whoever runs it
  may add one for someone without a phone, or a house pick. At "Start the
  tasting" a server-side Fisher-Yates shuffle (`crypto.randomInt`) hands out
  A, B, C…, so the order beers were added says nothing about whose is whose,
  and each bringer is told "Pour it as C".
- **Who knows what.** A member *knows* a beer if they brought it or added
  it. You cannot score your own beer in a blind tasting. A knower's style,
  ABV and who-brought guesses never score; an adder's stars do count. The
  crowd score excludes the bringer's stars (or they would vote for their
  own); on a home pour it is the bringer's alone (nobody else tasted it).
- **Scoring** (`POINTS`): style exact 3, same family 1, miss 0 ("something
  else" scores nobody); closest ABV 2 (ties share); right on who brought it
  2; each award 2. The crowd score shown is the mean **rounded to the
  nearest half star**; ranking uses the exact mean, then more scores.
- **Awards**, in a fixed order, ties shared (every winner gets the points):
  Best Palate (most style points, 1+), ABV Whisperer (most closest calls,
  a tie broken by the smaller average miss), Crowd Pleaser (blind: brought
  the top beer; ties share), Hometown Hero (home pours: the top local
  pour), Sleuth (blind: most right on who brought it), Contrarian (largest
  average gap from the others' average, over beers two+ others rated, at
  least half a star), Hop Head (highest average on IPAs incl. NA IPAs, with
  two+ people having rated one). Small crews simply get fewer: a crew of two
  never gets a Contrarian, a house pick never makes a Crowd Pleaser.
- **The Same-Can Challenge's window is checked on read** (`stageOf`):
  upcoming, open, then revealed from the first read after `closesAt` - no
  timer, nothing written (billed per request). The host can reveal early.
  Windows are instants; "This weekend" is `weekendWindow(now, offset)`,
  Sunday 23:59 in the **creator's** zone (the page sends
  `-getTimezoneOffset()`), and every phone shows the close in its own zone
  ("Open until Sun 11:59 PM your time"). 1 hour to 14 days. `?since=v` on a
  session also compares the stage, so a poll from before the close is never
  answered "same".
  - **Same can:** the host names a beer anyone can find (shown); its style
    and ABV stay hidden until the reveal, so the crew still guesses them
    ("pour it into a glass without reading the can"). The picker is a
    knower: their stars count, their guesses do not - the page says so.
  - **Home pours:** each member pours a local beer and scores their own;
    before the reveal the crew sees each pour's city and tasting notes (not
    its name, style, ABV or stars) and guesses its style and ABV from them.
  - Members may add the city they tasted from (optional, shown to the crew).
- **Polls are approval voting.** Tick every option you'd be happy with; the
  most ticks wins. Chosen over ranked choice because a crew picking a
  brewery is really asking "which would you go to", approval has no spoiler
  effect, it is one tap per option on a phone, and its result is readable at
  a glance. Results show to a member **after they vote** (or once it is
  closed), so the first ticks are not steered. A tie is shown as a tie and
  whoever started the vote (or the host) breaks it when closing. Anyone may
  add options; their adder, the starter or the host may remove one.
- **A crew is one document** (`crews/<id>`); each session and each poll is
  its own document carrying `crewId` (a session holds up to 8 x 20 scores -
  too much for one crew document over a season). Every session and poll
  write is a **transaction** (Firestore's, or a per-document queue in
  memory), so **two phones scoring at once both stick** (tested with six
  phones and the same writes without the transaction losing one). Each such
  write also bumps the crew's `v` with an increment, so a crew page polls
  `?since=v` and an idle crew costs one read. The memory store's `bump`
  goes through the same queue; `{mustExist: true}` stops a bump bringing a
  just-deleted crew back as a stub.
- **Members need no account.** A browser key (22 random characters) lives
  in an HttpOnly cookie `flight_k` scoped to the app's path; it is minted
  only on join and never stored - each crew keeps `sha256(key + crewId)`,
  so one phone is unlinkable across crews. **Keep my seat**: a signed-in
  member's seat also carries `acct`, an HMAC of the account id under a key
  derived from `IDENTITY_SESSION_SECRET` ("flight account v1"), so they come
  back as themselves on any device, and "My crews" is one `array-contains`
  query on `acctTags`. The crew holds no account id and no email. Member ids
  are random per crew; that is all a member learns about another, plus the
  name they typed and an emoji from a fixed set of 24.
- **Who may do what.** A member writes only as themselves: a score, a guess,
  a city or a vote is always keyed by the caller's own seat - a member id in
  the body is ignored. Whoever starts a session or vote runs it (start,
  reveal, close, delete) along with the host. The host (the account that
  made the crew, recognised by account) can rename the crew, rotate the
  code (old link and QR die; members unaffected), remove members and delete
  the crew. A member can leave. **A stranger gets the same 404 a missing
  crew gets on every route**, signed in or not.
- **Removing or leaving takes everything with it**: their scores, guesses,
  city and votes are scrubbed from every session and poll of the crew
  (`scrubMember`), and a beer they brought stays (others scored it) with
  nobody's name.
- **Limits** (`lib/crews.js` LIMITS, per instance, in memory, like Dibs):
  20 members a crew; 30 new members per address an hour; 30 **distinct**
  wrong codes or crew ids per address in 15 minutes, then even the right
  code waits (a dead code polled again counts once); 600 writes per address
  in 10 minutes; 10 crews per host; 100 sessions and 30 votes a crew. IPv6
  counts by its /64. Codes are 6 characters from 32 unambiguous ones.
- **Expiry on read.** A crew nobody has touched in 180 days is deleted - with
  all its sessions and votes - by the read that finds it.
- **Failures** (`fail()`/`failure()`, Receipt's): only the app's own errors
  reach the page with their words; a provider error is a 502 (503 "The AI is
  busy"). Nothing logged carries a name, a note, a crawl or a photo.

## Snap the label (the one model call)

`POST /api/snap` `{photo: {type, data}}`: `requireUser, requireBudget,
requireDailyCap` **then** a 6 MB parser (a stranger's body is never read),
bytes checked (JPEG/PNG/WebP by magic number, 4 MB) before anything is spent,
one forced tool `read_label` -> `{name, brewery, style, abv, confidence,
stylePrinted}`. The style is an enum of the fixed list plus "other". The
prompt says never to estimate an ABV; `ai.cleanLabel` keeps one only when it
is a plain number from 0 to 20 the model returned as printed (a string, 65,
"about 7" are no ABV) - a guessed ABV would quietly decide the ABV Whisperer.
Every string bounded and stripped. The page fills the Bring-a-beer form and
says "Check it against the can - nothing is saved until you press Add it",
flagging a missing ABV. The photo is shrunk to ~1600px in the browser, read
once, never stored or logged. 401 opens the account sheet, 402 the credit
sheet, 403 `verify-email` its sentence and "Send the link again".

## Hopscotch links

A poll option may be a Hopscotch crawl share link,
`https://beer.strongtechnicalconsulting.com/c/<id>` (the host from
`eriks-projects/site/index.html`; Hopscotch's `routes/collections.js`
serves `GET /api/shared-crawl/<id>` to anyone with the link). Flight reads
**only that public endpoint** - never Hopscotch's data - and only from the
server, fenced in (`lib/hopscotch.js`):

- **https, the one host** (`FLIGHT_HOPSCOTCH_HOST`, default
  `beer.strongtechnicalconsulting.com`), no port, no userinfo, the path
  `/c/<id>` with Hopscotch's own id pattern. http, another host, an IP, a
  look-alike (`beer.strongtechnicalconsulting.com.evil.com`) or another path
  is never fetched.
- **Redirects refused** (`redirect: 'manual'`; a 3xx is a failure), a
  4-second timeout, a 64 KB cap on the body (header and streamed), JSON only.
- What comes back is untrusted: the title, place, up to 12 stop names, miles
  and a first name, each bounded and stripped. The card links back to the
  crawl on Hopscotch.
- **On any failure the option keeps the text that was typed.** A stranger's
  link is never fetched (membership is checked first), and the fetch happens
  before the poll's transaction, never inside it.

## The first run

The page opens on the example: "Thursday Pour Crew", five invented friends
(Maya, Dev, Jonah, Priya, and Sam - the visitor), invented beers and
breweries. A dark strip: "This is an example crew - try scoring a beer, then
start your own" with **Start a crew** and **I have a code**. Below it, the
last session's awards ("Hazy vs West Coast": a four-beer blind tasting with
an NA wheat in it, six awards, a shared Best Palate), an open Same-Can
Challenge (the window closes this Sunday night on the visitor's clock) with
two of five done, a vote with four votes in, and a leaderboard over two
sessions. Scoring the can and voting work - on this phone only, never sent
- and anything that needs a real crew opens "Start a crew".

**Start a crew** asks a signed-out visitor for a free account, then a crew
name, your name and emoji, and lands on the Crew tab with the code in big
type, the QR (full screen on tap) and Share link. A friend opening `j/<code>`
sees the crew's name and size (not who is in it), types a name, picks an
emoji, and is in. Phones poll every 6 s (a crew) or 3 s (an open session)
while visible and stop when hidden. On a phone the tabs (Play, Vote,
Leaderboard, Crew) are a bottom bar; above 900px they are the left rail
(`desktop.css`) and cards sit in two columns.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8118/flight/
npm test        # pure rules first, then end to end over HTTP under a /flight mount
```

`FLIGHT_MEMORY=1` and `FLIGHT_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `FLIGHT_COLLECTION_PREFIX`
(set to `flight_` by the lab host) prefixes every top-level collection.
`npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`; the dev server does
not, so a fresh dev account gets the verify-email 403 on Snap (as live).
The fake model refuses a call that does not force a tool. Triggers in the
photo's bytes: `BLANK`, `INJECT`, `NOABV`, `MAXTOKENS`, `UPSTREAMnnn`;
anything else reads as "Fog Lantern", Tidewater Brewing, Hazy IPA, 6.8%.

`public/qr.js` is Dibs's vendored copy of Kazuhiko Arase's MIT "QRCode for
JavaScript", only its global renamed to `FlightQR`.

## Data (Firestore: `flight_*` in the lab database `challenge`)

- `crews/<id>` (16 random base64url characters) - `{name, code, ownerTag,
  acctTags, createdAt, updatedAt, v, members: [{id, name, emoji, host,
  keyHash, acct, joinedAt}]}`.
- `sessions/<id>` - `{crewId, kind: blind|samecan, mode: same|home, title,
  runner, stage, window: {opensAt, closesAt}, revealedAt, v, createdAt,
  updatedAt, beers: [{id, label, name, brewery, style, abv, broughtBy,
  addedBy, at}], scores: {beerId: {memberId: {stars, style, abv, chips,
  note, at}}}, guesses: {memberId: {beerId: memberId}}, cities: {memberId:
  city}}`.
- `polls/<id>` - `{crewId, question, runner, options: [{id, text, crawl,
  addedBy}], votes: {memberId: [optionId]}, closed, pick, v, ...}`.

Nothing else: no email, no account id, no browser key, no photo (tested).
Queries are single-field equality (`crewId ==`, `code ==`, `ownerTag ==`,
`acctTags array-contains`), so **no composite index**. Crews this phone
joined are remembered in `localStorage` `flight-crews-v1` (wrapped).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `c/:id`,
`j/:code`. Joining (no account): `GET|POST /api/join/:code`. Members
(cookie or kept seat): `GET /api/crews/:cid[?since=v]`, `POST
/api/crews/:cid/me`, `DELETE /api/crews/:cid/members/:mid` (leave; the
host: remove), `POST /api/crews/:cid/sessions`, `GET
/api/crews/:cid/sessions/:sid[?since=v&stage=]`, `POST|PATCH|DELETE
…/sessions/:sid/beers[/:bid]`, `POST …/start|reveal`, `PUT
…/scores/:bid|guesses/:bid|city`, `DELETE …/sessions/:sid`, `POST
/api/crews/:cid/polls`, `POST …/polls/:pid/options|close`, `DELETE
…/polls/:pid/options/:oid`, `PUT …/polls/:pid/vote`, `DELETE
…/polls/:pid`. Signed in (free): `GET|POST /api/crews`, `PATCH|DELETE
/api/crews/:cid`, `POST /api/crews/:cid/code|seat`. Metered:
`POST /api/snap`.

## Ideas not built yet

- **Photos of the night** (Memories-style), and a recap card image - the
  recap is text for now, which every group chat takes.
- **Reading a Hopscotch passport share** (`/p/<id>`) to seed a member's
  palate profile; only crawl links are read today.
- **A live "pour order" timer** for the table, and a "next round" button
  that copies a lineup into a new session.
- **An App Clip** from the QR so friends need nothing installed; a Live
  Activity with "3 of 5 scored".

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`, and
  page handlers are added with `addEventListener` through one `data-act`
  listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor or a member without an account;
  the snap's gates run before its 6 MB parser (tested: 401/402/403, not 413).
- Model output, Hopscotch's answer and every typed string are untrusted:
  cleaned, bounded, stripped of markup, control and bidi characters, and
  escaped on render.
- `c/*`, `j/*`, `/api/crews/*` and `/api/join/*` answer with `no-referrer`
  and `noindex`; a code and a crew id are keys.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
