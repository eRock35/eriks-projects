# For Claude: Chapter

A book club that keeps up - and never spoils the ending. For book clubs of
friends, neighbours, colleagues and families - especially the ones where
people read at different speeds and the group chat ruins the twist. A club
is started with a name and a book, everyone joins with a six-character code
(or a link) and a first name and an emoji - no account, no app - and then:

- **The progress board.** Each member moves their bookmark (the last chapter
  or page they have finished, or "finished"). The board shows everyone as a
  bookmark along the book's spine, the next meeting as a dashed finish line
  ("Thu · ch 42"), and a list with each reader against you: "Maya is 3
  chapters ahead of you", "Sam is 9 chapters behind you", "Priya has
  finished". A nudge against the meeting date: "Behind schedule - read 4
  chapters a day to reach chapter 42 by Thu", "On track - ...", "You're ready
  for the meeting on Thu." When everyone has finished, a celebration with a
  rating, the share card and "What's next".
- **Spoiler-safe notes (the heart of it).** A note - a reaction, never a
  quote - or a discussion question is tagged with the chapter it belongs to,
  never past where its author is. A member sees only the notes at or before
  their bookmark; the rest are a count: "🔒 4 notes waiting past chapter 18"
  with a chip per chapter ("ch 22 · 1"). Moving the bookmark forward unlocks
  them with a small reveal and "🔓 3 notes unlocked". Emoji reactions from a
  closed set of six. **The server enforces it**: a locked note's text,
  author and reactions are never in any response to a member who has not
  reached it - not the club, not a poll, not a reaction or delete attempt
  (both 404) - and the tests grep the responses for it.
- **What's next - the vote.** Members nominate books (title, author, one
  line why, chapters if known; two each, twelve in all). Approval voting:
  tap every book you would read. Counts stay hidden until the host closes
  the vote (from the host too), so nobody follows the crowd; "5 of 6 have
  voted" is shown. Most approvals wins; **a tie goes to the book nominated
  first, and the result says so** ("Frankenstein and The Moonstone tied on 4
  votes - Frankenstein wins the tie because it was nominated first"). The
  host starts the winner with one tap; the current book goes to the **Shelf**.
- **The shelf.** Every book finished together: each reader's 1-5 stars, the
  club average to one decimal ("4.2★ avg from 6 ratings"), and its notes,
  readable under the same spoiler rule against where each reader had got to
  when the club moved on (`final` positions are kept for exactly this).
- **Meetups.** Date, time, a place (with a map search link) or a video-call
  link (https only), "read to" a chapter (the board's finish line; empty =
  the whole book), RSVP Going / Maybe / Can't with names, and an `.ics`.
- **Discussion questions.** Members add their own (tagged by chapter, same
  rule). The Meet tab lists the questions up to the meeting's target.
- **Share card.** "Our club finished Pride and Prejudice - 4.2★ avg", 1080 x
  1350, drawn on the phone (stars are drawn shapes), two taps (draw, then
  share - iOS needs a fresh gesture for the share sheet), never uploaded. No
  names, no notes: the club name, the book, the average and counts.
- **Moving to another phone**: a one-time link (below). **Leave club**
  removes the member's notes, questions, bookmark, ballot, nominations,
  RSVPs, reactions and ratings.

Built 2026-11-06 as an **everyday** drop: Feedfix (2026-11-05) was a
business one, so today was the other kind. **Staging only**: no custom
domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/chapter`,
served at `challenge.strongtechnicalconsulting.com/chapter/`, data in
`chapter_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Every book club has the same three problems:

1. **Who has read how far?** Half the club is on chapter 30, someone has not
   started, the meeting is Thursday, and nobody knows whether to talk about
   the ending.
2. **The spoiler in the group chat.** The fast reader cannot help it, and
   the twist is gone for everyone else. So people stop talking between
   meetings, which is when a club is most fun.
3. **The endless "what next?" thread.** Forty messages, three polls and
   nobody sure what won.

Chapter solves all three in one link, free, with no accounts. A club adopts
it after one person shares a code, because joining takes a first name.

**Not a repeat:** Inside Joke is trivia from a group's photos and chats,
Settle decides where to eat, Pickup is who's in for a game. Nothing in the
lab or the portfolio tracks reading or hides anything by progress.

**Who pays.** Almost nobody. Starting, joining, the board, notes, reactions,
votes, meetups, the shelf, the share card and moving phones are free, need
no account and make no model call. A **free** account is optional: it keeps
clubs on the account so they open on another device, and it unlocks the one
metered thing - "Suggest discussion questions" (Haiku free, Sonnet for
members via `identityLib.planFor`), about a cent.

**How it becomes an iPhone app.** A widget with "You're 40 pages behind" and
the meeting countdown; a notification when notes unlock past your bookmark
or when the vote closes (the web app has no sender, so it has none); the
share sheet taking the join link; Live Text to read a chapter number off a
page.

## The decisions that matter

- **One rules file, run three times.** `public/chapter-core.js` is UMD
  (`window.ChapterCore` in the page, `require` in the server and tests):
  cleaning, codes, the book and progress, the board and nudges, **the
  spoiler rule** (`canSee`, `splitNotes`), notes and reactions, nominations,
  approval voting and its tie-break, the next book and the shelf, ratings,
  meetups, the `.ics`, `memberView` (the one shape the server sends and the
  page draws, for real clubs and the made-up one), the AI's range and
  answer, and the made-up club. **No clock and no dice** (tested): "today",
  "now" and every new id are handed in. Every write is a **patch of keys**
  (`{set: {'members.m1.pos': 12}, del: []}`) that the server hands to
  Firestore's `update()` and the made-up club applies in memory with
  `applyPatch`.
- **Chapters over pages.** A book has chapters (1-400) or, if it has none,
  pages (1-3000); the unit is chapters whenever they are given, because
  chapters are the same in every edition and pages are not - a page-based
  note would unlock at the wrong place for someone with another edition.
  The start form says so. Mixing the two (a reader entering a page, the
  rule working in chapters) would need a page-to-chapter guess, and a wrong
  guess is a spoiler, so it is not offered.
- **A position is "the last chapter I have finished"** (0 = not started).
  Reaching the last chapter is finishing. A note is tagged 1..your position
  (never past it; at 0 you cannot post yet). `canSee`: the author always;
  a finisher always; otherwise `note.at <= position`. Moving a bookmark
  back hides notes again - except your own.
- **The nudge** (`nudge`) measures against a straight line from the day the
  book started to the meeting's target: below it is "Behind schedule",
  otherwise "On track"; the per-day number is what is left over the days
  before the meeting day (Mon -> Thu is three days). Day numbers come from
  `Date.UTC`, so a week across a clock change counts days, not hours. "by
  Thu" within a week, "by Thu, Nov 19" further, "tomorrow", "today".
- **Approval voting**: one ballot per member (`vote.ballots.<mid>`, a list
  of nomination ids), one key, so two people voting at once both count.
  `tally` counts current members only, each nomination once per ballot.
  `closeVote` freezes the counts, the winner and the sentence onto the club,
  so a member leaving afterwards does not change a result already shown.
- **The next book** (`startNext`): the current book goes to `shelf.<id>`
  with its ratings, its dates and `final` (where everyone got to); the
  winner (or a book the host types) becomes the book; every bookmark goes to
  0; the vote starts again; planned meetings stay with "read to" cleared,
  past ones go. A shelf keeps 40 books; the oldest drops, and its notes
  with it.
- **Meetups and the `.ics`**: floating local time (`DTSTART:20261112T190000`,
  no TZID, no Z) - "7 PM" wherever the phone is, across a clock change,
  which is what a club that meets in one place means (Takeback's and Tada's
  reasoning). **One refinement:** a club records its creator's time zone,
  and when someone saving the file is in another zone (a video-call club
  across time zones), the event carries the exact instant in UTC instead,
  worked out from the club's zone (`zonedMs`, DST-safe). The Meet tab says
  "Club time (America/New York)" when the zones differ. Escaped, folded at
  75 octets, CRLF, a stable UID, a two-hour reminder.
- **Neutral copy**: they and them, never a gendered pronoun (tested over
  every string and this file).

### The made-up club ("Try it")

"The Quillfeather Readers" reading **Pride and Prejudice** (public domain):
six invented readers - Alex (you, the host, chapter 18), Maya (21), Theo
(30), Priya (finished), Jordan (15), Sam (9); a Thursday meeting at an
invented café, five to eleven days out, "read to chapter 42", with RSVPs;
ten notes and questions in the readers' own words that **quote nothing**
(tested: no quotation marks at all), four of them locked past chapter 18; a
vote under way among four public-domain classics (Frankenstein, Middlemarch,
The Moonstone, Little Women) in which **your vote for The Moonstone makes a
tie that Frankenstein wins because it was nominated first** - the tie-break
shown by playing; and a shelf (Jane Eyre 4.2★, The Hound of the
Baskervilles, The Picture of Dorian Gray). Every tap works through the same
core functions - move the bookmark and watch notes unlock, react, post,
vote, close the vote, RSVP, rate - and nothing is saved. A ribbon says so,
with "Start my own" and "Leave".

## Two phones, one club (trip-planner's packing lesson)

A club is one document (`clubs/<id>`) whose members, progress, ballots,
RSVPs and ratings are maps keyed by member. Every write goes through
`store.transactKeys`: read the club inside a transaction, let the core
decide, then write **only the keys it changed** with `update()`, plus the
version. Notes are **one document each** (`notes/<id>`), so posts never
collide, and a reaction is one key on its note (`reactions.<mid>`), written
in a transaction. `test/run.js` moves ten bookmarks at once, casts ten
ballots at once, reacts twice to one note at once and posts ten notes at
once - all stick - and shows the same two bookmark writes as a plain
read-change-write losing one. A note change bumps the club's version so
pollers notice.

Phones re-ask with `?since=v` when the app comes back to the foreground and
every 10 s while a club is on screen (one read when nothing moved); a redraw
waits while someone is typing in the page.

## Who may do what

- **Members are browsers.** An HttpOnly cookie `chapter_k` (22 random
  characters, `Path` = the app's base, SameSite=Lax, a year and a bit) is
  minted when you start, join or claim a move; the club keeps only
  `sha256(key + club id)` per member, so one phone is unlinkable across
  clubs. The page never reads the cookie.
- **The host** is the creator (`host: true`) until handed over ("Make
  host"). Host only: plan, edit and remove meetings; edit the book; close
  and re-open the vote; start the next book (the winner or another); remove
  a member; make a new join code (the old one dies at once, members are
  unaffected); delete the club. A host leaves only after handing over -
  unless they are the last reader, when leaving deletes the club. Any
  member: their bookmark, notes and questions (delete their own), reactions,
  nominations (take their own off; the host can take any off), their ballot,
  RSVP, ratings, their own name and emoji, inviting (the code is in every
  member's view), moving phones, leaving. A host can remove any note they
  can see; a host cannot see past their own bookmark either.
- **A stranger gets the same 404 a missing club gets**, word for word, on
  every route - unknown id, malformed id, expired club and not-a-member all
  read "This club isn't here. It may have been deleted, or it closed after
  120 days with nobody opening it." (tested).
- **Writes come from this page**: every non-GET `/api/*` outside the shared
  account refuses `Sec-Fetch-Site` other than same-origin/none (403), an
  `Origin` naming another host (403) and a body that is not JSON (415).

### Joining and moving phones

- **Codes**: 6 characters from 32 unambiguous ones (no I, O, 0, 1), typed
  however ("abc-def"). A join link is `…/chapter/#join=ABCDEF`: the code
  rides in the **fragment**, which a browser never sends to a server or in
  a Referer. The page shows a QR of the link (Pickup's vendored encoder,
  global renamed `ChapterQR`).
- **What a code opens** before joining: the club's name, the book and how
  many read it, and which emoji are taken - not who, not anything anyone
  wrote. A name already in the club gets a number ("Sam 2").
- **Move to another phone**: the member's seat gets `move: {hash, exp}` -
  the hash of a 22-character secret, for 30 minutes. The link is
  `#move=<club id>.<secret>` (a fragment again). The new phone claims it in
  a transaction that deletes it: it works **once**, two claims at once give
  one seat, an expired one is cleared by the read that finds it, and the
  seat then answers to the new phone's key - the old phone is out (tested).
  Five links an hour per member. Nothing lingers outside the club: the
  pending move lives on the seat and dies with the club.

### Limits (per instance, in memory: they slow a script, they do not stop a determined one)

`lib/clubs.js` LIMITS and `Core.LIMITS`: 30 readers a club; notes 500
characters and questions 300 (six lines at most); 400 notes a book; 12
nominations (two a member); 8 meetings; 40 books on the shelf; 10 new clubs
per address an hour; 30 new readers per address an hour; **30 distinct
wrong codes, ids or move links per address in 15 minutes, then even the
right one waits** (a phone polling the same dead id counts once); 600
writes per address and 240 per member in 10 minutes; 40 notes per member an
hour; 5 move links per member an hour; 30 clubs kept per account. IPv6
counts by its /64. A club nobody has touched in **120 days** is deleted
(with its notes) by the read that finds it - no timer, billed per request.

## Signed in (free, optional): keep my clubs on my account

Club page -> "Keep on my account". The seat gets `acct` = an HMAC of the
account id under a key derived from `IDENTITY_SESSION_SECRET` ("chapter
account v1"), and `accounts/<that tag>` = `{clubs: {<club id>: <member id>},
updatedAt}`. A signed-in device with no key is then that member; signed
out, it is a stranger again. Home lists the account's clubs beside this
phone's. **Never the email or the account id in any lab document**, and
never a browser key (the account holds club ids and member ids, not keys -
safer than the brief's "member keys": a key in a document would be a
password at rest). Stale entries (left, removed, expired) are dropped on
read. No secret on the service: 503 and a sentence.

## The model call (metered, signed in only)

**`POST /api/ai/questions`**: `requireUser, requireBudget, requireDailyCap`
**then** the route's own 4 KB parser (401 / 402 / 403 / 503 before it,
never 413 - tested), then `ai.brief` (exactly `{club, from, to}`; anything
else is a 400), then membership (a stranger's 404), then `aiRange`: **the
range never goes past where the asker is**, so the questions cannot spoil
the book for them - all before any model call. Then one forced tool
`suggest_questions` through one call site (`ai.ask`), told **only**
`Book: "<title>" by <author>. The club has read chapters <from> to <to> (of
<total>).` - no club name, no member's name, no note, no progress (tested by
reading the fake's log). Then `cleanQuestions`:

- at most six; 12-240 characters of plain text; anything with markup, a
  link (`https:`, `www.`, a bare domain), a control character or **a quoted
  span over twelve words** is dropped (curly, straight and guillemet quotes;
  an unclosed quote counts to the end) - no long quotes from a book that
  may be under copyright;
- each tagged with the chapter it needs, **inside the range** or dropped;
  a page-based book's questions all sit at the end of the range;
- `knowsBook`: the model must say when it does not know the book well, and
  then write general questions, which sit at the start of the range; the
  sheet says "The AI doesn't know this book well, so these are general
  questions";
- repeats dropped; none left is a 422.

Nothing is stored by the route. The sheet shows exactly what is sent ("“Pride
and Prejudice” by Jane Austen, chapters 1-18. Nothing else - no names, no
notes, nothing anyone in the club wrote."), labels the answers
**"AI-written - check before the meeting"**, and adds only the ones a member
taps, as ordinary questions of theirs (`ai: true` shows the label). Signed
out it explains and offers a free account; the made-up club says it is for
a real club; 401 opens sign-in, 402 the credit sheet, 403 `verify-email`
its sentence and "Send the link again"; sheets size themselves below the
shared confirm-your-email banner.

## Offline

The service worker (`sw.js`, network first, `chapter-shell-v1`) keeps the
app's own files so it opens offline; it **never** answers `api/`. The page
keeps the **last club it saw** in `localStorage` (`chapter-last-v1`; one
club, the member's own view of it) and draws it offline under "You're
offline - this is the club as of 3:42 PM. Moving your bookmark, notes and
votes need the internet." Leaving or deleting a club clears it.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8161/chapter/
npm test        # the rules first, then end to end over HTTP under a /chapter mount
```

`CHAPTER_MEMORY=1` and `CHAPTER_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `CHAPTER_COLLECTION_PREFIX`
(`chapter_` from the lab host) prefixes every collection. `npm test` runs
with `REQUIRE_VERIFIED_FOR_FREE_AI=0` (the gate itself is held by the
suite's gate test and by the lab's). The fake refuses a call that does not
force a tool, keeps every request (`fakeClient.calls`), and takes
`fakeClient.mode` for one call: `blank`, `unknown`, `inject`, `maxtokens`,
`upstreamNNN`.

`test/run.js` (33 tests): text and hostile input (markup, bidi, zero-width,
objects, long strings), the code alphabet and the server's draws, the book
and positions, progress and the board's lines, the nudge with a fixed clock
(behind, on track, ready, late, done, none; the whole book; across a clock
change), the spoiler rule (author, finisher, at or past; counts by chapter;
the view carries no locked text; tags never past your bookmark), reactions,
approval voting and the tie-break sentence (ballots of leavers, taking a
book off, counts hidden until the close, frozen after), the next book and
the shelf (ratings, `final`, the 40 cap), members (numbered names, a full
club, everything removed with a member, handover), meetups (every refusal,
eight kept, RSVP), the `.ics` (floating, UTC across zones in November and
July, a skipped hour, all-day, escaping, folding, CRLF, no injected event),
the AI's request and answer, the made-up club (fictional, public domain,
no quotes, the tie it makes), contrast in both themes plus the literal
colours and the lab card, 44 px targets, the page's promises (relative URLs,
no inline script, the banner, wrapped storage, every received string
escaped, only the listed API paths, what the AI sheet says, the locale
fallback, the service worker), neutral copy, no invisible characters and no
key-shaped strings in any source file, the local switches, the prefix and
single-field queries; and over HTTP: signed out with zero model calls and a
401 before the AI parser, cross-site writes refused, the gate order and one
call site, start / join / the key cookie and its per-club hash, **the
server never sending a locked note's text** (club, poll, write responses,
react and delete 404s, the shelf), concurrent bookmarks, ballots, reactions
and notes, host powers and handover (removal takes notes and reactions; the
last reader leaving deletes the club), the one-time move link (single use,
two claims at once, expiry), the same 404 for unknown, malformed, expired
and not-yours and the 120-day expiry, the limits (distinct wrong codes,
readers per address, notes per reader, a full club, long fields cut),
hostile input end to end, the AI over HTTP (refusals with no model call,
what the model saw, hostile, unknown, empty, long and failing answers, a
provider error never shown), the 403 / 402 / 503 gates, and keeping clubs
on an account (another device signed in, signed out a stranger, no email or
account id anywhere).

Rendered with Playwright at 390px and 1280px, light and dark: the first
run, Try it (board, notes with locked counts, moving the bookmark and the
unlock, the meetup and an RSVP, the vote, voting into the tie and its
winner, the shelf, the share card saved as PNG, the AI sheet in the made-up
club), starting a club and its invite sheet with the QR, joining with the
code in a second browser, the host posting a note and a question, the
joiner's locked counts, the unlock preview in the progress sheet and the
unlock, a reaction and a reply, nominating, both voting, the winner, the
next book and the shelf with its notes, planning a meetup, the RSVP and the
`.ics` (checked floating), the board with its finish line, the AI sheet
signed out, signed in and its answers added, keeping the club on the
account, the move link, the lab card on the landing page and the app under
the lab host; plus everyone finishing, the last club offline (and a write
saying it needs the internet) and a sheet under the confirm-your-email
banner. No console error or CSP violation, nothing scrolling sideways.
Then a hostile pass (markup, bidi, zero-width and very long names, titles,
notes, nominations and places, through the page and the API): no dialog,
no injected element, no bidi character on the page. Found on the way: a
cleaner turned `{}` into "object Object", a reader at chapter 0 could tag
chapter 1, the spine's labels shifted when one was hidden, the share card's
average overflowed its box, and on a phone the newly unlocked notes sat
below the compose card (it now scrolls to them).

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`). `public/qr.js` is
Pickup's copy of the vendored Kazuhiko Arase MIT "QRCode for JavaScript".

## Data (Firestore: `chapter_*` in the lab database `challenge`)

- `clubs/<id>` (16 random base64url characters) - `{name, code, tz,
  createdAt, updatedAt, v, book: {id, title, author, chapters, pages,
  started, ratings: {<mid>: 1-5}}, members: {<mid>: {name, emoji, host,
  joinedAt, pos, done, at, keyHash, acct?, move?: {hash, exp}}}, meetings:
  {<id>: {date, time, place, link, upTo, rsvps: {<mid>: yes|maybe|no}, by,
  at}}, vote: {noms: {<nid>: {title, author, why, chapters, pages, by,
  at}}, ballots: {<mid>: [nid]}, closed: {at, winner, line, counts, voters,
  tied} | null}, shelf: {<bid>: {title, author, chapters, pages, started,
  finished, ratings, final: {<mid>: pos}, order}}}`.
- `notes/<id>` - `{club, book, mid, kind: note|question, text, at, ai,
  reactions: {<mid>: emoji}, createdAt}`.
- `accounts/<tag>` - `{clubs: {<club id>: <member id>}, updatedAt}`, only
  for a signed-in member who asked.

No email, no account id, no browser key, no address anywhere (tested over
the whole store). Queries are single-field equality (`code ==`, `club ==`),
so **no composite index**. On the device: `chapter-clubs-v1` (the clubs this
phone is in: id, name, book, emoji), `chapter-last-v1` (the last club seen,
for offline), `chapter-me-v1` (the name and emoji last used to join) - every
access wrapped in try/catch, and the page works without them.

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, the page, `sw.js`. No
account: `POST /api/clubs`, `GET|POST /api/join/:code`, `POST /api/move`.
Members (`/api/c/:id`): `GET` (`?since=v`), `PUT progress`, `PATCH me`,
`POST notes`, `DELETE notes/:nid`, `PUT notes/:nid/react`, `PUT
meetings/:mt/rsvp`, `POST noms`, `DELETE noms/:nid`, `PUT ballot`, `PUT
rating`, `GET shelf/:bid/notes`, `POST move`, `DELETE me`. Host: `PATCH
book`, `POST|PATCH|DELETE meetings[/:mt]`, `POST vote/close`, `POST
vote/reopen`, `POST next`, `POST host`, `DELETE members/:mid`, `POST code`,
`DELETE /api/c/:id`. Signed in (free): `GET /api/account/clubs`,
`PUT|DELETE /api/account/clubs/:id`. Metered: `POST /api/ai/questions`.
The shared account at `/api/auth`.

## What is deliberately not built

- **Notifications** ("notes unlocked", "the vote is closed"): no sender on
  this platform; the iPhone app is where they belong.
- **Book search / covers** (an ISBN lookup for title, author and chapter
  count): a books API is new infrastructure for a daily drop. The member
  types the book; the share card and shelf draw a letter on a spine.
- **Page-to-chapter mapping** for mixed editions (see "Chapters over
  pages").
- **Reporting a note** to the host: the host removes what they can see; a
  report queue would be moderation infrastructure for a club of friends.
- **Several clubs reading at once / a reading schedule per week**: one book
  at a time, with meetings as the milestones.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the AI route's gates run
  before its parser; every other route keeps a 16 KB limit.
- Every name, note, title, place, nomination and model answer is untrusted:
  cleaned in the core (no markup, bidi or invisible characters, bounded;
  names letters only; links https only), and escaped on render (the test
  cuts out every `esc(...)` and fails on a field concatenated into markup);
  the `.ics` is escaped for its own format; canvas text is drawn as text.
- `Referrer-Policy: no-referrer` everywhere and `noindex` on the club APIs;
  codes and move secrets travel in fragments only.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body, a note or a name.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
