# For Claude: Pickup

Who's in, fair teams, and who owes for the court. For anyone who runs a
weekly pickup game or casual rec group - basketball, five-a-side,
volleyball, pickleball, ultimate, padel - out of a group chat. Everyone taps
**In / Maybe / Out** (no app, no account), past the cap they go on a
**waitlist** and an Out moves the first waiter up with a line saying so
("Lena's in - Jo dropped out"), the host makes **fair teams** in one tap,
results build a **season** (standings, streaks, attendance, Player of the
Week), and **court money** is split among who actually played with Paid
ticks and a reminder line ready to paste.

Built 2026-10-08 as an **everyday** drop: Burnrate (2026-10-07) was a
business one, so today was the other kind. A free pick from ordinary life
(friends, hobbies, health) - not from the inbox, not a holiday. Not a
repeat: Flight is beer games for a crew, Dibs splits a restaurant bill by
item, Chorus deals chores; nothing in the lab or the portfolio organises a
game. **Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/pickup`,
served at `challenge.strongtechnicalconsulting.com/pickup/`, data in
`pickup_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Every weekly game runs on the same chore: "who's in?" in the group chat, a
scroll of thumbs-ups, someone counting on their fingers, the eleventh person
not knowing if they are playing, lopsided teams picked by the two best
players, and a week of chasing $6 each for the court. Pickup is the one
link the organiser drops in the chat instead - and the thing a group adopts
after one person shares it, because answering takes one tap and nobody has
to install anything.

**Who pays.** Almost nobody. The example group, a group on one phone,
answers, the waitlist, +1s, teams, results, the season, votes, court money,
sharing, putting a group online and joining one are free and make no model
call. Only the host of an online group needs a **free** account (so it is
theirs to run and delete); everyone else joins with a link, QR or code and
**no account**. The one metered thing is **reading a messy group chat** with
AI (Haiku free, Sonnet for members via `identity.planFor`), about a cent,
paid by whoever asks - and a free reader on the phone tries first.

## The decisions that matter

- **One rules file, run three times.** `public/pickup-core.js` is UMD
  (`window.PickupCore` in the page, `require` in the server and tests): the
  sports, the week, answers and the waitlist, teams, rotation, results,
  standings, Player of the Week, court money, the share lines, the free chat
  reader and `cleanGroup`. The server checks and stores; the page draws and
  runs the group on this phone and the example with the very same
  functions; the tests check one file.
- **The week.** A group has an IANA time zone (`tz`, from the host's phone);
  games are `{date, time}` wall-clock in that zone (`zonedMs`, DST-safe, a
  skipped hour lands an hour later). The game repeats on `sched.wd` (Monday
  = 0) at `sched.time`. **The next game opens when this one is done** - 12
  hours after kickoff, or when the host taps *Wrap up* - by the read that
  finds it (`ensureGame`; no timer, billed per request), with every regular
  "not answered yet". The season keeps 26 games. Game ids are `g` + the date
  (a letter is added if the host moved a date onto another game's).
- **First come, first served, +1s included.** An In carries `t`, the moment
  it was given (strictly later than anything already in the game, so two
  answers in one millisecond still have an order); the first `cap` by `t`
  are In, the rest wait in that order. Saying In again keeps your place;
  Maybe or Out and back in goes to the back. A +1 is a guest named by
  whoever brings them, placed when added like anyone (at most 3 a regular,
  20 a game); going Out takes your +1s with you. Every change that moves
  someone writes a log line - "Sam's in - Jo dropped out", "Ben is on the
  waitlist - the cap went down" - with names snapshotted. Kickoff closes
  answers for everyone but the host (no-shows are the host's to fix).
- **Fair teams** (`balance`, pure and deterministic). Lower is better, in
  this order: broken split/together lines; positions spread unevenly (two
  keepers on one team; football GK, volleyball setter and ultimate handler
  are on by default, basketball's "big" is off); the skill gap (team totals,
  a smaller team counted at the group's average for its empty spot, so 6 v
  5 of equal players reads "dead even"); the very same teams as last week;
  then how many of last week's teammates are together again. Balance always
  beats variety: last week's teams are avoided only among equally even
  splits. Up to 30,000 possible splits are all enumerated (two teams up to
  18 players, three up to 12, four up to 12), so the answer is the best
  there is - the tests check it against an independent brute force on 60
  random cases; past that, a snake draft from several starts plus a bounded
  swap search (40 players in four teams in well under a second). Ties break
  by a hash of the game id and the split, the draft's order by a hash of the
  game id and each person. **Reshuffle** asks for the n-th best *different*
  split (never better than the one before; wraps when there are no more).
  The gap is said plainly: "Dead even on skill", "Within 1 point", "2.5
  points apart", plus a sentence when a pair had to be broken, positions
  couldn't be spread, or the teams repeat. Bibs are Orange / White / Blue /
  Green, always with the name beside the swatch.
- **Three or four teams: winner stays on** (`rotation`): two play, the rest
  queue; the loser goes to the back; the winner stays for two games at most,
  then goes to the back too so everyone plays; a draw sends both off, the
  one on longer first. The score form defaults to the pair that is on.
- **Results** are a score (11-8) or just who won, per game; any member may
  add one, the host or whoever entered it may take it back. **Who played**
  is the host's tick list if set, else the teams, else whoever is In.
  **Standings** (`standings`, computed on read): games, W-L-D by each match
  a person's team played, win %, the current streak ("🔥 3 wins in a row"),
  attendance ("came 9 of the last 10"), Player of the Week count; most wins
  first.
- **Player of the Week**: one vote per regular who played, for anyone else
  who played (a +1 can win), changeable until it closes. It opens at
  kickoff and closes when the host closes it, everyone has voted, or 72
  hours pass - worked out on read. **Votes are secret until it closes**,
  from the host too: a member's view carries only their own vote and the
  count. Ties share it.
- **Skill numbers are private.** Each regular rates themselves 1-5 ("Just for
  fun" to "Ringer", default 3); the host can quietly adjust anyone (`adj`,
  which teams use). Only the host sees other people's numbers; each person
  sees their own; a +1's number is for the host and whoever brought them.
  Why: people rate themselves honestly only if nobody else sees it; in a
  friends' game a public "2/5" is a put-down that ends someone's Thursdays;
  and the host can correct a self-rated 5 without a confrontation. The
  server strips them (`groups.view`), and tests hold that no other
  regular's number reaches a member's response. Team totals are shown to
  the host only; everyone sees the gap. Split/together lines are the host's
  alone for the same reason ("keep the brothers apart" is not for the
  brothers).
- **Court money, no payments.** Pickup never holds or moves money - it keeps
  the list, and says so on the Money tab. A game's cost is split among who
  played, to the cent (the spare cents go one each to the first players by
  id); a +1's share is owed by whoever brought them; whoever paid the court
  (`collector`, the host by default) is settled automatically. A game's
  money is owed from kickoff. Anyone ticks themselves Paid; the host ticks
  anyone. The running balance is every unpaid share across the season
  ("Ben owes $12 · Sep 24, Oct 1"), and the reminder line is ready to paste:
  "Court money for Thursday Hoops: Ben $12 (Sep 24, Oct 1) · Nina $6
  (Oct 1). Pay Alex - thanks!"
- **Sharing goes through the phone's share sheet** (or copies): the game
  ("Thursday Hoops 7pm @ Riverside Rec Center - 8 in, need 2. Tap to say
  you're in: <link>"), a nudge to one person, the teams, the money
  reminder. **Pickup never sends anything itself.** The place gets a
  Google Maps search link built from its text.

### Two phones, one group (trip-planner's packing lesson)

An online group is one document (`groups/<id>`) whose `games` are a map
keyed by game id, and each game's answers, guests, payments, votes and
results are maps keyed by person or id. Every busy write - an answer, a +1,
teams, a score, Paid, a vote, wrap-up - goes through `store.transactKeys`:
read the group inside a transaction, let the core decide, then write **only
the keys it changed** (`games.<gid>.rsvps.<pid>`, its log lines, the
version) with Firestore's `update()` - never the whole document. Twelve
phones answering at once all stick, and the last spot claimed by two phones
at once gives one In and one first on the waitlist (`test/run.js` holds
both, and shows the same two writes as a plain read-change-write losing
one). Members, settings and lines are whole-document transactions (rare,
still safe). Phones poll `?since=v` every 5 s while visible (one read when
nothing moved).

### Where a group lives

- **The example** ("Thursday Hoops", `public/sample.js`): 16 regulars,
  basketball on Thursdays at 7pm at Riverside Rec Center, $60 a court, Sam
  and Jo kept apart, Mia and Priya together. Six past weeks and this one are
  **played by the real rules** - answers through `rsvp`, teams through
  `makeTeams`, scores through `addMatch`, votes through `vote`, payments
  through `markPaid` - with who does what a hash of the week and the person.
  This week: 11 In for 10 spots, 2 maybe, Ben not answered, Jo dropped out
  so Lena moved up, Kai's +1 on the waitlist ("Full - 2 waiting"), and teams
  made. Ben owes for two weeks and Nina for one. If last week's vote is
  still open, Alex (you) hasn't voted, so a visitor can. Every tap works and
  nothing is saved; changing the group itself offers "Make it yours".
- **On this phone** (`localStorage` `pickup-group-v1`, every access wrapped,
  read back through `cleanGroup`): no account, no server. The host is "you"
  and taps answers in for everyone; votes are tapped in per voter.
- **Online** (`g/<id>`): from Group, **Put it online** (sign in free) sends
  the group and its season (`cleanGroup`: only this group's people, only
  known fields) to `POST /api/groups`, clears the phone's copy and lands on
  the invite card - code, QR (full screen on tap), Share link. A friend
  opening `j/<code>` sees the group's name, sport, when and where it plays,
  this week's headline and the **open seats** (regulars the host typed who
  have not joined) - "Which one is you?" - or joins as someone new with a
  name, an emoji and (optionally) their own skill number.

## Who may do what (online)

- **Members** are this browser (an HttpOnly cookie `pickup_k`, path-scoped,
  22 random characters, stored only as `sha256(key + groupId)`) or a
  signed-in account that holds the seat (`acct`, an HMAC of the account id
  under a key derived from `IDENTITY_SESSION_SECRET`, "pickup account v1").
  The group holds no account id and no email.
- Members answer for themselves and their own +1s, bring +1s, add and take
  back scores they entered, vote, tick themselves Paid, and set their own
  name, emoji, skill and position. **The host** (recognised by account)
  answers for anyone, applies a pasted chat, edits this week's game, makes
  and reshuffles teams, sets who played, closes the vote, ticks anyone Paid,
  wraps up, adds regulars, adjusts skill, sets split/together lines and the
  group's schedule, rotates the code (old link and QR die) and deletes the
  group. A member can leave; the host can't (delete instead).
- **A stranger gets the same 404 a missing group gets** on every route,
  signed in or not.
- **Limits** (`lib/groups.js` LIMITS and `Core.LIMITS`; per instance, in
  memory, like Chorus): 40 regulars, 20 guests a game, 3 +1s a regular, 24
  results a game, 20 lines, 5 groups a host; 30 new members per address an
  hour; 30 **distinct** wrong codes or ids per address in 15 minutes, then
  even the right code waits; 600 writes per address in 10 minutes. IPv6
  counts by its /64. A group nobody has touched in 180 days is deleted by
  the read that finds it (no timer).

## Paste the group chat (the one model call)

The host pastes the chat (or picks a screenshot) on the Game tab.

- **The free reader runs first, on the phone** (`parseChat`): WhatsApp
  exports (`[08/10/2026, 18:42:11] Sam Lee: I'm in`, Android's `08/10/2026,
  18:42 - Sam: in`, US dates, 12-hour times with the narrow space, the LRM
  and `~` WhatsApp adds), iMessage-style `Sam: can't make it`, `in - Mia`,
  `Mia - in`, `Tom out`, `Jo ✅`, numbered "who's in" lists (`1. Sam`, `2.
  Jo +1`, `3. Mia (maybe)`), headings (`Out: Ben and Chris`). Ambiguous
  ("can't wait, I'm in"), long or nameless lines are left as "lines the
  free reader couldn't be sure about". A person's last answer wins. System
  lines and media placeholders are skipped.
- **The AI is for the messy rest**: `POST /api/replies/text` `{text, names}`
  (the unread lines) or `POST /api/replies/photo` `{photo, names}`.
  `requireUser, requireBudget, requireDailyCap` **then** the route's own
  parser (64 KB text, 4 MB screenshot - a stranger's body is never read;
  tested 401/402/403, never 413), then the input checks (20,000 characters
  with letters in them; a screenshot by its magic bytes, 2.9 MB decoded)
  before anything is spent, then one forced tool `record_replies` ->
  `{replies: [{name, answer: in|maybe|out, plusOnes}]}`. `ai.cleanReplies`
  puts every answer through `Core.cleanReply` - the same function a parsed
  answer goes through - keeps a person's last, 60 at most. The text or
  screenshot is read once, never stored or logged (tested).
- **Nothing changes until Apply.** Answers are matched to regulars by name
  (`matchReplies`: the whole name, a first name only one regular has, or
  the chat name's first word - "Sam Lee" is Sam); unmatched names are
  offered as new regulars. The host sees a ticked list with each answer
  editable; Apply sends `POST /games/:game/rsvps {answers, add}` (host
  only), which goes through `rsvp` one by one so the waitlist rules are the
  same, +1s included.
- Signed out, the AI buttons explain and offer a free account (the text is
  kept); 402 opens the credit sheet; 403 `verify-email` shows its sentence
  and "Send the link again".

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8121/pickup/
npm test        # pure rules first, then end to end over HTTP under a /pickup mount
```

`PICKUP_MEMORY=1` and `PICKUP_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `PICKUP_COLLECTION_PREFIX` (set to
`pickup_` by the lab host) prefixes every top-level collection. `npm test`
runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call
that does not force a tool. Triggers in the screenshot's bytes or the text:
`BLANK`, `INJECT`, `MAXTOKENS`, `UPSTREAMnnn`; anything else is five answers
(Sam in, Jo out, Mia maybe, Tom in with a +1, Priya in).

`public/qr.js` is Shelf Life's copy of Flight's vendored Kazuhiko Arase MIT
"QRCode for JavaScript", only its global renamed to `PickupQR`. The shared
files (`lib/identity.js`, `identity-store.js`, `byok.js`, `stripe.js`,
`webauthn.js`; `public/desktop.css`, `passkey-client.js`, `verify-banner.js`)
are synced copies - edit them in `eriks-projects/shared/`.

## Data (Firestore: `pickup_*` in the lab database `challenge`)

- `groups/<id>` (16 random base64url characters) - `{name, code, tz, sport,
  perSide, usePos, cur, sched: {wd, time, place, cap, cost}, collector,
  lines: [{a, b, k}], ownerTag, acctTags, createdAt, updatedAt, v,
  members: [{id, name, emoji, skill, adj, pos, host, keyHash, acct,
  joinedAt}], games: {<gid>: {id, date, time, place, cap, cost (cents),
  rsvps: {<pid>: {a, t, by}}, guests: {<xid>: {name, by, t, skill}},
  log: {<lid>: {k, who, whom, why, t}}, teams: {sides, n, gap, broken,
  posOff, same, made, basis} | null, matches: {<rid>: {a, b, sa, sb, w, t,
  by}}, played, paid: {<pid>: {t, by}}, votes: {<voter>: cand}, potwClosed,
  done, created}}}`.

That is the only collection: no email, no account id, no browser key, no
chat text, no screenshot (tested). Queries are single-field equality
(`code ==`, `ownerTag ==`, `acctTags array-contains`), so **no composite
index**. Groups this phone joined are remembered in `localStorage`
`pickup-groups-v1`; the last one opened in `pickup-last-v1`, so the
home-screen icon opens it.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `g/:id`,
`j/:code`. Joining (no account): `GET|POST /api/join/:code` (`{seat}` or
`{name, emoji, skill}`). Members: `GET /api/groups/:gid[?since=v]`,
`PATCH|DELETE /api/groups/:gid/members/:mid`, `POST
/api/groups/:gid/members` (host), `PUT /api/groups/:gid/lines` (host), and
per game `/api/groups/:gid/games/:game`: `PATCH` (host), `PUT
rsvp/:pid {a}`, `POST rsvps {answers, add}` (host), `POST guests`, `POST
done` (host), `POST|DELETE teams` (host), `PUT played` (host), `POST
matches`, `DELETE matches/:rid`, `PUT vote {cand}`, `POST vote/close`
(host), `PUT paid/:pid {paid}`. Signed in (free): `GET|POST /api/groups`,
`PATCH|DELETE /api/groups/:gid`, `POST /api/groups/:gid/code`. Metered:
`POST /api/replies/text`, `POST /api/replies/photo`.

## What is deliberately not built

- **Reminders and push.** There is no sender on this platform; the nudge and
  the money reminder go out through the organiser's own share sheet.
- **Payments.** No payment integration and no money held - a Venmo/Cash App
  link per person (Dibs has them) would fit later; holding money would not.
- **Public ratings or Elo.** Skill is self-reported and private by design;
  an Elo from results would rank friends publicly, which is the opposite.
- **"Keep my seat" across devices** for members who joined signed out (Flight
  has it): a new phone means taking the seat again from the link after the
  host frees it. Signed-in joiners are recognised by account anywhere.
- **Calendar export, recurring exceptions** (skip a holiday week): the host
  edits this week's date or wraps up instead.
- **The obvious iPhone shape**: a widget with "8 in · need 2", an App Clip
  from the QR so joiners need nothing installed, a Live Activity for the
  waitlist.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`,
  handlers by one `data-act` listener (tested here and by
  `challenge/test/lab.js`).
- No model call for a signed-out visitor or a member without an account; the
  metered routes' gates run before their parsers, and going online's 512 KB
  parser runs after its sign-in.
- Model output and every typed string are untrusted: cleaned, bounded,
  stripped of markup, control and bidi characters, and escaped on render.
- `g/*`, `j/*`, `/api/groups/*` and `/api/join/*` answer with `no-referrer`
  and `noindex`; a code and a group id are keys.
- Failures (`fail()`/`failure()`, Receipt's): only the app's own errors reach
  the page in their words; a provider error is a 502 (503 "The AI is busy").
  Nothing logged carries a name, an answer, chat text or a screenshot.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
