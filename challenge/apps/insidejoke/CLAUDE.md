# For Claude: Inside Joke

Trivia made from a group's own photos and group chat. A host makes a group
("The Strongs", "College crew"), everyone joins by link, QR or a 6-character
code with just a name and an emoji, and the questions come from **their own
photos** (AI, metered), **their own group chat** (read on the phone, mostly
free) and **what they write** (free). They play **five a day, apart**, on
their own time - a daily round with a leaderboard and streaks - or **all
together on game night**, live, each on their own phone beside a video call.

Built 2026-10-02 as an extra drop, the day Erik asked for it. **Staging
only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/insidejoke`,
served at `challenge.strongtechnicalconsulting.com/insidejoke/`, data in
`insidejoke_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Erik asked for it on 2026-10-02: "Family/friends trivia or game night engine
... personalized trivia from shared photos or group chat history ... think
about how we can play a game when I'm not with the people. I travel a lot and
would like to stay connected." He asked for it built the same day (item 1 of
"Queued by Erik (2026-10-02)" in `challenge/CLAUDE.md`).

An **everyday** drop. Not a repeat: nothing in the lab or the portfolio is a
party game. Pop Quiz makes quizzes for a team; this makes a family's inside
jokes into a daily habit.

**Apart is the headline.** The daily round is what keeps a family that is
spread over four time zones talking: five questions, two minutes, "Mom 4/5
from Atlanta, Erik 3/5 from Denver", a streak, and a result card to paste
into the family chat. Live game night is the second mode, for a video call.

**Who pays.** Almost nobody. Members never need an account and never trigger
a model call. A host needs a **free** account (so the group is theirs to run
and delete). The two metered things - questions from a photo, and a "who said
it?" round from a chat - are paid by whoever asks, about a cent each (Haiku
for the free tier, Sonnet for members, via `identity.planFor`). The free chat
stats, writing your own questions, the daily round, the board and live game
night cost nothing to serve beyond a few reads.

**The honest risks.** A model can misread a photo; so every AI question is a
**draft** its author reviews, edits or deletes before it joins the bank, and
the facts that make an answer right are never the model's (below). A chat
can hold things people would not want quoted; so the page says "Only share a
chat everyone in it would be happy to play with" before anything is read, the
chat is read on the phone, and only the questions someone chose are kept.

**How it becomes an iOS app.** A Photos picker (with the same on-device
redraw), a share extension for WhatsApp's "Export Chat", a daily local
notification for the round (the web app has no sender, so it has none),
widgets for the streak, and SharePlay for game night. The data model does not
change.

## The decisions that matter

- **One rules file, run twice.** `public/ij-core.js` is UMD
  (`window.InsideJokeCore` in the page, `require` in the server and tests):
  chat parsing, stats, PII stripping, the excerpt, quote verification,
  question cleaning, grading, the daily draw, streaks, the leaderboard, the
  result card and live points.
- **Chats are read on the phone** (Drip's "nothing is uploaded" promise).
  `parseChat` reads WhatsApp exports from iOS (`[3/14/24, 9:14:05 PM] Mom:`,
  with the narrow no-break space) and Android (`02/10/2026, 21:14 - Mom:`),
  D/M/Y, M/D/Y, D.M.Y and Y-M-D, 2- and 4-digit years, 24-hour, "AM" and
  "a.m."; the day/month order is decided once per file (a number over 12
  decides it; else dots mean day first, AM/PM month first). Multi-line
  messages are joined; system lines (iOS marks them with U+200E under the
  group's name; Android has no "Name: ") are counted and dropped, as are
  deleted messages; media lines count as messages but never as text. A
  pasted "Name: message" log works too (no times, so no time stats). The
  iPhone's `.zip` export is opened in the browser (`DecompressionStream`,
  `_chat.txt` inside). 12 M characters, 300,000 lines.
- **Free questions from the stats** (`chatStats`, `statQuestions`): who sends
  the most, night owl (11pm-4am), early bird (5-8am), who laughs most
  ("lol", "haha", 😂, "jaja"...), a favourite emoji that is one person's and
  nobody else's, longest message, first message, busiest day, how many
  messages (closest number). **Only a clear winner becomes a question** - a
  tie is nobody's. The importer ticks which to keep.
- **The "who said it?" round** (metered): the page sends a **sampled
  excerpt** - up to 400 messages from eight windows spread across the chat,
  media and short lines left out - with phone numbers, emails and links
  replaced by `[phone]`/`[email]`/`[link]` **on the phone** (`stripPII`), and
  the server strips and bounds it again (`cleanExcerpt`). One forced tool,
  `make_chat_questions`, returns quotes only - it is not even asked who said
  them. **Each quote must be an exact substring of exactly one speaker's
  lines** (`verifyQuote`; case and spelling as written, a line under two
  speakers is nobody's, under 12 characters or 3 words is not a question);
  the true speaker is read from that line; options are the speaker and the
  three busiest others. Unverified quotes are dropped. The excerpt is never
  stored or logged.
- **Photos** (metered, the uploader pays): the browser reads **only the EXIF
  date** (for the year) - a location tag is noticed so the page can say it
  will be removed, but **never read or sent** - and redraws each photo
  through a canvas, which strips all EXIF: a ~640px JPEG thumbnail (<= 110 KB)
  and a ~1280px copy for the model. Gates, membership, **then** the 4 MB
  parser; the thumbnail is sniffed, sized from its frame header (<= 800px a
  side, 120 KB) and its metadata segments (APP1-13, APP15, comments) are
  stripped again on the server; the model copy is read once and dropped. One
  forced tool, `make_photo_questions`, 1-3 questions of `where`, `when`,
  `who_took`, `whats_happening`, `odd_one_out`, `caption_this`. **The facts
  are never the model's**: a `where` answer is the place the uploader typed
  (the model only offers decoys; its copy of the real place is dropped; no
  place, no `where`), a `when` answer is the year from EXIF or the uploader
  (no year, no `when`; within a year counts), `who_took` is built on the
  server from the uploader and other members. The prompt forbids inventing
  facts and **identifying anyone from their face**; `FACE_ASK` drops any
  question that asks who someone is, as a second line. Only the thumbnail
  (its own document, never the group's) and the drafts are stored; the hint
  is not. 300 photos a group.
- **Drafts.** AI questions are `status: 'draft'`, visible only to their
  author, who can edit the wording (never the answer of a where/when/who-took
  or who-said-it question) or delete them, then "Add N to the bank". Written
  questions and the chosen stats questions go live at once (their author
  reviewed them by writing them).
- **The bank's index lives on the board document** (`bank: {qid: [style,
  photoId, createdBy]}`), so drawing a day reads one document and ten
  questions, never the whole bank. 1,000 questions a group.
- **The daily round** (`pickRound`): deterministic, seeded by group id and
  date (FNV-1a into mulberry32), the bank sorted by id first so its order does
  not matter; questions used in the last 30 days are held back while fresh
  ones remain (then the longest-unused come first); photo, chat and written
  questions take turns; at most one caption (it scores nothing); one question
  per photo in the five where possible. It draws ten: the shared five and five
  spares. **A player never gets a giveaway** (`roundFor`/`trivialFor`): a
  question they wrote, a photo they uploaded, or a quote that is their own is
  swapped for a spare, keeping the shared five where possible so results
  compare. A player's five are fixed at their first answer. The round is
  frozen as a snapshot when first drawn (`rounds/<gid>_<date>`), so editing
  or deleting a question never changes a day already drawn.
- **The group's day.** Each group has a time zone (the host's at creation,
  changeable); `dayIn(tz)` decides "today" and the round locks at that
  midnight - an answer for another day is a 409 `closed` and the page loads
  the new round. Members elsewhere play by the group's day ("closes in 5h 12m
  (group time)"). `msToMidnight` asks the zone, so DST nights are 23 or 25
  hours.
- **Answering**: one question at a time (the page shows the verdict), each
  answer a transaction on the round document, so concurrent answers all
  stick; an answer stands (409 on a second). **Only ever as yourself**: the
  member comes from the cookie or the account, never the body. Results -
  everyone's score, marks and "from" - show only once you have finished.
  "Playing from" is typed (30 characters), never located.
- **Grading**: multiple choice and true/false exact; numbers within the
  question's tolerance (closest wins in live); captions unscored (they are
  voted, and the group's favourite so far is shown).
- **Streaks** (`streakOf`): consecutive group days finished; alive through the
  whole of the next day ("play today to make it 5"), over after a full day
  missed. The board (`boards/<gid>`) keeps `days: {date: {mid: [score, of]}}`
  for 400 days, all-time totals and best streaks; recording a day is
  idempotent. Leaderboard: this week (7 group days), 30 days, all time.
- **The result card** is text with no link and nothing that opens the group:
  "Inside Joke · The Strongs / Fri 2 Oct · 4/5 / 🟩🟥🟩🟩🗳️ / 🔥 6-day streak".
- **The nudge** is a line on the page ("Dad and Tío Rafa haven't played
  today") and a copyable message - no push, no mail; there is no sender.
- **Live game night** (`lives/<gid>`, one game at a time): the host opens the
  room (5-20 questions, from photos/chat/written, 15/20/30 s or "I'll move it
  on"); members see it on their Live tab and join with a tap; newcomers join
  the group with the code. Questions are snapshots (answers stay on the
  server until the reveal). **No server timer**: whichever request finds a
  question past its window (+1.5 s grace) or a reveal past its 6 s moves the
  game on, as of when it was due (`liveAdvanceDue`). The page's countdown is
  for show; **the server checks the answer time against the open window**.
  Points: right answers 500 + up to 500 for speed; a number question's
  closest guess(es) 1,000 at the reveal; a caption's most popular choice gives
  its voters 500. The host's "next" names the question it means to leave, so
  a double tap cannot skip one. Polling every 1.5 s while the tab is visible,
  `?since=v` answers "same". A game idle for 6 hours is gone on the next read.
  Podium at the end. It works beside any video call - the page says so.
- **Members need no account.** A browser key (22 random characters) lives in
  an HttpOnly cookie `ij_k`, Path = the app's base, SameSite=Lax, minted only
  on join or create; it is never stored - each group keeps
  `sha256(key + group id)`, so one phone is unlinkable across groups. Member
  ids are random per group (`m` + 11 characters); that, a name, an emoji and
  a colour is all anyone learns about another member. **Signing in keeps a
  seat across devices**: "Keep my seat on every device" ties the seat to the
  account's tag (`acct`, an HMAC of the account id under a key derived from
  `IDENTITY_SESSION_SECRET` - never the uid or email); a signed-in device with
  no cookie is then that member. The host is the member whose tag owns the
  group, and only while signed in.
- **Host powers**: rename, time zone, remove a member (their scores go too),
  rotate the join code (the old one is dead at once; members are unaffected -
  they come back by the group's own link), open/close live games, remove any
  question (seeing prompts, never answers), and **delete the group**, which
  deletes every member, question, photo, round, the board, any live game and
  the code. A member who is not the host gets a 403 on host routes;
  **anyone who is not a member gets the 404 a missing group gets** on every
  group route, thumbnails included.
- **Thumbnails** are served only through `GET /api/groups/:gid/photos/:pid`,
  to members, with `Cache-Control: private, no-store`, `nosniff` and
  `image/jpeg`; never a public URL or a signed link.
- **Limits** (`lib/groups.js` LIMITS, per instance, in memory, like Dibs):
  30 members a group; 10 groups per host; 30 new members per address an hour;
  30 **distinct** wrong codes per address in 15 minutes, then even the right
  code waits (a dead code polled again counts once); 600 writes (answers
  included) per address in 10 minutes. IPv6 counts by its /64. Codes are 6
  characters from 32 unambiguous ones, typed however ("abc-def").
- **Failures** (`fail()`/`failure()`): only the app's own errors reach the
  page with their words; a provider error is a 502 (503 "The AI is busy")
  sentence. Nothing logged carries a name, a message, a question or an image.

## Gemini, the lab AI guard and "Make a round" (2026-11-23)

Erik's per-app AI plan gives Inside Joke **Gemini**: "Your photos become
trivia rounds, plus 'who said it?'" (photo-heavy, high volume). It is built
and **switched off**: `INSIDEJOKE_AI_PROVIDER=gemini` turns it on; unset (or
anything else) is Claude exactly as before, so merging changed nothing live.
Turning it on is Erik's call (and needs Vertex AI enabled for
`challenge-run@`, see `challenge/CLAUDE.md` "Lab AI guard").

**`INSIDEJOKE_AI_PROVIDER=claude-first` (2026-11-23, read at startup like `gemini`):** the photo and chat
readers run Claude first, exactly as unset; any Claude failure but a burst refusal (SDK error, nothing the
cleaners keep, Claude's `monthly-cap` - then Gemini alone, before the stream - or no key) runs the Gemini
path for the same request (`claudeOrGemini`/`readWith`, log `[insidejoke] claude failed (<code>); used
gemini`). "Make a round" is on (Gemini only). Tests: `test/claude-first.js`.

- **What the switch does.** (1) The two existing calls - one photo, a chat
  excerpt - go to `gemini-3.8-flash` through `global.LAB_AI_GUARD.gemini.generate`
  with a `responseSchema` instead of a forced tool, and then through **the
  same cleaning** (`ai.cleanPhotoQuestions`, `ai.cleanChatQuestions`). (2)
  **Make a round** appears on the Questions tab (`/api/meta` says
  `ai.round: true`): up to **6 photos** the member picks and up to **12
  quotes they type** as "Name: what they said", plus an optional one-line
  note, become one round of drafts in **one call**
  (`POST /api/groups/:gid/round`; a 404 with the switch off).
- **Grounded and kind** (`lib/gemini.js`). The facts are never the model's,
  as before: where = the place typed, when = the year from EXIF or typed,
  who took it = the uploader. Typed quotes are sent as numbered lines
  **without their speakers**; a quote that comes back must be an exact
  substring of exactly one speaker's typed lines (`Core.verifyQuote`) and
  the speaker is read from there; the other answers are the other people
  quoted, then group members. The prompt forbids identifying anyone and
  asking about age, looks, body, health, ethnicity, religion and the like,
  and mocking; `SENSITIVE` (with `Core.FACE_ASK`) drops any question or
  answer that does it anyway. Clamped: 2 questions a photo, 12 quotes, 15
  questions a round, every string through `Core.cleanQuestion`.
- **The member reviews first.** Everything is a draft only its author sees
  ("To review"): edit, delete, then "Add N to the bank". Nobody plays a
  question that was not checked.
- **Photos.** Shrunk and redrawn on the phone (EXIF and location gone): the
  usual 640px thumbnail and, for a round, a 1024px copy of at most 280 KB
  (the server refuses over 300 KB; one photo keeps the 1280px copy). **The
  data promises are unchanged**: the model's copies are read once and
  dropped; only the thumbnail of a photo that got a question is stored;
  typed quotes and the note are never stored - only the questions.
- **Order of a metered call**: `requireUser, requireBudget, requireDailyCap`,
  membership, (the switch, for `/round`), the 4 MB parser, the request's own
  checks (a 400 costs and counts nothing), **`LAB_AI_GUARD.allow`** (its 429
  / 503 message is sent as is, with `code`), then the stream and the call,
  then `LAB_AI_GUARD.record` with `priceUsd`. The Claude path is wrapped the
  same way (`askClaude`; a member's own key is not recorded). An app run on
  its own has no guard and skips it.
- **Who pays.** Still whoever asks. A Gemini call is charged to the person's
  ledger at its real dollars through `identity.recordUsage` (written as the
  Haiku input tokens that cost the same; `route` says
  `round:gemini-3.8-flash`, `photo:…`, `chat:…`), and to the lab's month. A
  call that failed after billing is still paid for (`VertexError.usage`).
  A round is about two cents.
- **Stand-in and tests.** `fakeai.createGemini()` answers the three schemas
  with no network (triggers in its header). `test/gemini.js` (second half of
  `npm test`, run with the switch on) holds the gates, the guard order, the
  clamps, what is stored and what is charged; `test/run.js` holds the
  default (`PROVIDER === 'claude'`, no round route, guard around Claude).
- **Fallback (2026-11-23).** With the switch on, the photo and chat readers
  run Claude's path unchanged (its own allow, meter, record) when Gemini
  fails for any reason but a burst refusal: a thrown error, an answer the
  cleaners leave empty, Gemini's `monthly-cap` (checked before the stream),
  no helper (`allowWithFallback`, `geminiOrClaude`; one log line
  `[insidejoke] gemini failed (<code>); used claude`). Bursts are sent as
  is. "Make a round" is Gemini only and keeps its own errors.
- **Privacy page**: when the switch goes on it should say Google (Vertex AI)
  where it says Anthropic (and, with the fallback, Anthropic too).

## Design (2026-11-23 redesign)

The lab's HOA Desk look, in `public/app.css` (one file; `desktop.css` is
still served but the page no longer opts into it - no `dk` class):

- Pure white (true black in dark), **one accent**: the fuchsia of its
  `lab.js` pair (`#a21caf`; `#f0abfc` in dark). Status colours only for
  right/wrong/streak. Members' twelve colours and the four live answer
  colours are identity, unchanged.
- Sections and hairline-divided lists, not boxes; a 1px hairline card (12px
  corners) only for the side panels. Pill buttons (48px+ primary, 44px
  minimum), 10px inputs. System font, five sizes (13/15/17/22 + display).
- **Navigation**: one `<nav>` inside the top bar. On a phone it is a slim
  floating translucent pill (1.5px line icons, a label and a small accent
  mark only on the current tab); from 900px it sits in the top bar with a
  quiet underline. The phone top bar has **no backdrop-filter** on purpose
  (it would trap the fixed pill inside it).
- **First visit**: a centred hero ("Trivia from your own photos and group
  chat.", Play today's round / Start a group) above the example family.
- **No `style=` anywhere**, in HTML or written by script: helper classes,
  `data-c="<colour id>"` for member colours (the twelve are listed in
  app.css - keep them in step with `ij-core.js` COLORS), `.w1`-`.w20` bars.
- Motion (press, sheet, verdict pop) only under
  `prefers-reduced-motion: no-preference`.
- Measured in headless Chrome at 390, 320 and 1440, both themes, every tab
  and the round sheet: lowest text contrast 5.5:1 light, 6.6:1 dark; no
  sideways scroll; no CSP or console errors.
- Taps from a group's home (Today): play = 1 (Start); board, live, invite
  tab = 1; make a round / add from photos / chat / write = 2 (Questions,
  then the row); copy the invite link = 2. First visit: play the example or
  start a group = 1.

## The first run

A first visit opens on the example: "The Riveras" (made up; their "photos" are
simple SVG drawings in `public/sample.js` - a lake dock, a snowy cabin, an
80th birthday cake, a beach - no stock or real photos). A centred hero says
what the app is, with **Play today's round** and **Start a group**, and a
line that this is an example family and nothing is saved. Today's five (a where, a "who
said it?", a night-owl stat, a closest-number, a what's-happening) are graded
by the same core; three Riveras have already played (Abuela 5/5 from San
Juan...), the board has streaks (Abuela 🔥 23; the viewer, Lucía, 🔥 4 "play
today to make it 5"), the Live tab shows last Friday's podium, and the chat
import works on any chat you pick (it is read on the phone; saving it asks you
to start a group). No account, no model call, nothing saved.

A browser that has groups (or a signed-in account) opens on **Your groups**,
with "Start a group", "Join with a code" and "Play the example". A join link
(`j/<code>`) shows the group's name and faces, then name, emoji and colour.
A group (`g/<id>`) has five tabs - Today, Live, Board, Questions, Group - a
floating pill on a phone and part of the top bar on a desktop, where the round
and "who's played" sit side by side.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8117/insidejoke/
npm test        # pure rules first, then end to end over HTTP under an /insidejoke mount; then test/gemini.js with the switch on
```

`npm run dev` keeps the free-AI email check on (as production does); add
`REQUIRE_VERIFIED_FOR_FREE_AI=0` to try the AI paths with a fresh account.

`INSIDEJOKE_MEMORY=1` and `INSIDEJOKE_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `INSIDEJOKE_COLLECTION_PREFIX` (set to
`insidejoke_` by the lab host) prefixes every top-level collection. The fake
model refuses a call that does not force a tool. Triggers - in photo bytes:
`BLANK`, `FACE` (only face questions -> 422), `INJECT` (hostile output),
`MAXTOKENS`, `UPSTREAMnnn`; in an excerpt: `INVENTED`. Otherwise a photo gets
where/when/caption/who-took (the route keeps three) and a chat gets five real
quotes (one with a wrong speaker attached, ignored) plus an invented, a
paraphrased, a shared and a too-short one (all dropped).

`public/qr.js` is Dibs's vendored copy of Kazuhiko Arase's MIT "QRCode for
JavaScript", with only its global renamed to `InsideJokeQR`.

## Data (Firestore: `insidejoke_*` in the lab database `challenge`)

- `groups/<gid>` - `{name, code, ownerTag, accountTags, tz, createdAt,
  updatedAt, v, members: [{id, name, emoji, color, keyHash, acct, host,
  joinedAt}], photoCount, questionCount}`.
- `codes/<CODE>` - `{gid}`; replaced on rotation.
- `questions/<qid>` - `{gid, status ('draft'|'live'), source ('own'|'chat'|
  'chat-ai'|'photo'), createdBy (member id), createdAt, kind, style, prompt,
  quote, options, members, answer, tolerance, unit, photoId, aboutName}`.
- `photos/<pid>` - `{gid, by, thumb (base64 JPEG <= 120 KB), bytes, width,
  height, createdAt}`. One document each, never in the group's.
- `rounds/<gid>_<date>` - `{gid, date, cands, qs: {qid: snapshot}, answers:
  {mid: {order, picks: {qid: {a, ok}}, score, of, done, at, from}}, v}`.
- `boards/<gid>` - `{days, total, best, used, bank}`.
- `lives/<gid>` - `{state, by, seconds, qs, idx, openedAt, closesAt, revealAt,
  endedAt, players: {mid: {score}}, answers: {idx: {mid: {a, ms, pts}}},
  results, createdAt, updatedAt, v}`.

Nothing else: no chat, no excerpt, no full-size photo, no hint, no email, no
account id, no browser key, no location. Browser storage: `ij-groups-v1`
(the groups this browser joined), `ij-tab-v1`, `ij-from-v1` (every access in
try/catch).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `g/:id`, `j/:code`.
Joining (no account): `GET /api/code/:code`, `POST /api/code/:code/join`.
Host (free account): `POST|GET /api/groups`, `PUT|DELETE /api/groups/:gid`,
`POST /api/groups/:gid/code`, `POST|DELETE /api/groups/:gid/live`,
`POST /api/groups/:gid/live/next`. Members (cookie or account):
`GET /api/groups/:gid[?since=v]`, `POST .../me`, `POST .../link` (signed in),
`DELETE .../members/:mid` (self, or the host), `GET|POST .../today`,
`GET .../board`, `GET|POST .../questions`, `PUT|DELETE .../questions/:qid`,
`POST .../questions/publish`, `GET|DELETE .../photos/:pid`,
`GET .../live[?since=v]`, `POST .../live/join|answer`. Metered
(`requireUser, requireBudget, requireDailyCap`, membership, then the parser):
`POST .../photos` (4 MB) `{thumb, image: {type, data}, year, place, hint}`,
`POST .../chat` (512 KB) `{excerpt: [{n, t}]}`, and - only with
`INSIDEJOKE_AI_PROVIDER=gemini` - `POST .../round` (4 MB) `{photos: [{thumb,
image: {type, data}, year, place}] (<= 6), quotes: [{n, t}] (<= 12), hint}`.
Everything else: 64 KB.

## Ideas not built yet

- **Photo albums by event** ("Lake Lanier 2019"), and a "this day N years
  ago" question.
- **Voice notes** ("whose laugh is this?") - needs storage the lab does not
  want for a trial.
- **A weekly recap card** for the family chat (week's winner, longest streak).
- **Telegram / iMessage / Signal exports** - only WhatsApp and pasted logs
  are read today.
- **Push reminders** for the daily round: there is no sender (an iOS app's
  local notification is the right shape).

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`
  (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor or a member without an account,
  ever; the metered routes' gates and membership run before their parsers
  (tested: 401/402/403/404, not 413).
- Model output, chats and members' names are untrusted: cleaned, bounded,
  stripped of markup, control and bidi characters, and escaped on render.
- `g/*`, `j/*`, `/api/code/*` and `/api/groups/*` answer with `no-referrer`
  and `noindex`; a code or a group id is a key to the group.
- **Privacy page:** `strongtechnicalconsulting.com/privacy` should describe
  Inside Joke: chats read on the phone with only chosen questions kept, the
  stripped excerpt sent to Anthropic for a "who said it?" round, photos
  redrawn on the phone (EXIF and location removed) with only a thumbnail
  kept for members, the model's copy read once, and deletion.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
