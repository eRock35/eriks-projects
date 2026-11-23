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
- **My library** (added 2026-11-11, Erik's ask): a reader's own books,
  across every club, seen by nobody else. Add one by **scanning the barcode**
  on the back cover, by **typing the ISBN**, or **by hand**; title, author,
  cover and pages come from **Open Library**. Each copy can be tagged
  **special edition** and/or **signed**, with a short note. See "My
  library" below.

- **The 2026-11-22 upgrade** (Erik's brief, a real club is using it): page
  *and* chapter on the board with "where's everyone" at a glance; **threads**
  (a note can get replies) and **meeting notes** on a meetup, both under the
  spoiler rule; **Read it** (the Internet Archive's reader for a
  public-domain scan, otherwise links out); **Buy this book** (a store's own
  page, optional affiliate id). See "The club upgrade" below - and its
  first section, "Clubs that were already here".

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
(tested: no quotation marks at all), four of them locked past chapter 18;
five replies (two of them under locked threads, so never sent) and last
week's meeting with three meeting notes (one locked); "Read it" opens a
public-domain scan of the book at the Internet Archive; a
vote under way among four public-domain classics (Frankenstein, Middlemarch,
The Moonstone, Little Women) in which **your vote for The Moonstone makes a
tie that Frankenstein wins because it was nominated first** - the tie-break
shown by playing; and a shelf (Jane Eyre 4.2★, The Hound of the
Baskervilles, The Picture of Dorian Gray). Every tap works through the same
core functions - move the bookmark and watch notes unlock, react, post,
vote, close the vote, RSVP, rate - and nothing is saved. A ribbon says so,
with "Start my own" and "Leave".

## The club upgrade (2026-11-22)

Erik's brief: make it a much better club app - progress, in-app reading
where a legal source exists, a buy button, per-chapter threads and meeting
notes - **without breaking the club that already uses it**.

### Clubs that were already here (the non-negotiable)

There is **no migration step** and nothing is rewritten on read. Every new
field is optional, written only when someone uses the new thing, and read
with a default when absent:

| New field | Where | Absent means |
|---|---|---|
| `members.<mid>.alt` | club | no page/chapter beside the bookmark (`null`) |
| `book.isbn`, `shelf.<bid>.isbn` | club | buy links search by title and author |
| `re` (+ `kind: 'reply'`) | a `notes` document | an ordinary note or question |
| `meet`, `meetDate`, `decision` (+ `kind: 'minutes'`) | a `notes` document | an ordinary note or question |

No collection is new or renamed (still `clubs`, `notes`, `accounts`,
`libraries`; replies and meeting notes are `notes` documents, found by the
same single-field `club ==` query, so still **no composite index**). No
existing key changed meaning. The member key cookie, its per-club hash,
the account tag and pending move links are untouched. An ordinary note is
stored with exactly the nine keys it always had, a bookmark move without a
page writes the same three keys, an edit that says nothing about the ISBN
writes the same four (all tested). The view the server sends only gained
fields (`board.glance`, `rows[].alt`/`moved`, `notes[].replies`,
`meetings[].notes`/`lockedNotes`, `book.isbn`, `stores`), and the page reads
each of those with a default - a view saved on a phone before the deploy
(the offline copy in `chapter-last-v1`, or a tab left open) still draws.

`test/run.js` "older clubs keep working" stores a club, three notes and a
pending move link **written out by hand in the shape they had before this
change** (plus a second club holding the least a club could hold), then
over HTTP with the old cookie: loads it, checks the board, the locked
count and the nudge, moves a bookmark, votes into the first-nominated
tie-break, RSVPs, rates, reacts, reads the shelf under the rule, claims
the old move link once, starts the next book and leaves - and checks that
the stored documents gained no field they were not given and that an old
note was not rewritten. Never read or touch production data to check any
of this: the fixtures are the check.

### Progress: page and chapter both

The spoiler rule still runs on **one** unit per book (chapters when given),
for the reason under "Chapters over pages". What is new is `alt`: a reader
may add **the page in their own copy** (for a chapter book; the chapter, for
a page book) in the bookmark sheet. It is shown beside the bookmark and on
the board ("ch 14 / p. 151") and **decides nothing** - `canSee` never reads
it (tested). "+1 chapter" clears a page that would now be stale. The board
also gained `glance` ("2 ahead of you, 1 with you, 1 behind, 1 finished" and
"The club runs from chapter 3 to the end - the middle reader is at chapter
12") and when each bookmark last moved ("moved 2 days ago", from the `at`
the seat always had). **No location of any kind**: nothing asks where a
phone is, and a test fails if `geolocation` ever appears.

### Threads: a note can get replies

A reply is a `notes` document with `kind: 'reply'` and `re: <note id>`. **The
extension of the spoiler rule: a reply is read exactly when its thread is.**

- It carries the thread's chapter (`at` is copied from the note by the
  core, whatever the client sent), never one of its own.
- Only a member who can read the note can reply to it. A reply, a reaction
  or a removal aimed at a locked thread - or at a reply under one - is the
  same 404 a missing note gets, word for word.
- `threadsFor` (the one place) decides visibility with `canSee` **on the
  thread's note**, then attaches its replies. So a locked thread's text,
  author, replies, the replies' authors and reactions are in no response;
  the locked count is threads only (replies are not even counted).
  "The author always sees their own" applies to the thread's note, not to
  a reply: someone who replied under chapter 12 and then moved their
  bookmark back to 5 loses the thread, their own reply included.
- A reply never outlives its thread: removing a note removes its replies;
  a member leaving or being removed takes their notes, their replies, and
  every reply under their notes. A reply whose note is somehow gone is
  never shown. No replies to replies, none to meeting notes.
- Limits: 300 characters, 40 replies a thread, 600 a book, and the same 40
  posts an hour per reader as notes. The 400-notes-a-book cap counts
  threads and meeting notes, not replies.
- The Notes tab groups threads by chapter ("Chapter 11 - 2 threads") with
  a jump-to-chapter picker over the chapters this reader has reached.

### Meeting notes

On each meeting card: what was discussed, and what was **decided** (a tick
box; decisions list first). Any member can add one - during the meeting or
after. A meeting note is a `notes` document with `kind: 'minutes'`,
`meet: <meeting id>`, `meetDate` and `decision`, **tagged with a chapter
like any note and hidden by the same `canSee`**: never past where its
author is; a reader behind gets "2 meeting notes waiting past chapter 3"
and a count per chapter, never the text. "Who was there" is the RSVP list
the meeting already had. The sheet says to pick an early chapter for plans
that spoil nothing. They are not in the Notes tab or its locked count.
Removing a meeting (or one dropped to make room for a ninth) removes its
notes (`sweepMeetingNotes`); when the club moves to the next book they stay
with the shelved book, dated, under the rule. 30 a meeting.

`test/run.js` greps every response a reader behind can get - the club, a
poll, their own writes' answers, the shelf, a reply/reaction/removal
attempt - for the locked thread's text, its reply's text and both ids, and
the same for a locked meeting note.

### Read it: a legal copy, or a link out

Chapter **never hosts, copies or proxies a book's text.** `GET
/api/c/:id/read` (members only, 40 an hour per address) runs
`lib/reader.js`:

1. Open Library's `search.json` for the book's title and author - nothing
   about the club or the reader;
2. if the matching work is `ebook_access: public` with `public_scan_b`, one
   request for that Internet Archive item's metadata: it must be a text,
   not `access-restricted-item`, and in no lending or print-disabled
   collection;
3. the answer is `{kind: 'read', ia}`, `{kind: 'borrow', work}` or `{kind:
   'none'}`.

For `read`, the page shows "Free to read" and - **only after a tap** - puts
the Archive's own reader (`https://archive.org/embed/<id>`, the form Open
Library documents for embedding) in a sandboxed frame with no referrer.
The text goes from the Archive to the reader's browser. A "+1 chapter"
button sits above the frame. `borrow` and `none` are links out (Open
Library, a library search, the buy sheet). Project Gutenberg and Standard
Ebooks are always offered as **search links the reader opens** - never
fetched from here: Gutenberg's site is for people, not programs (its
policy pages answered this build's fetch with 503 and a six-hour
Retry-After; it sends robots to mirrors and an offline catalogue, too much
for a shared 512 MiB instance), and Standard Ebooks keeps feeds and bulk
downloads for its patrons and disallows fetching its text pages.

What the two services ask of automated callers, and what is done: say who
you are (one `User-Agent` naming the app and its address - not an email,
which stays out of this public repo), cache (found a week, not found a
day, failures never), go slowly (at most two requests per uncached
lookup). **Cost, measured:** no Firestore read or write at all; the cache
holds 500 answers of a few hundred bytes - 0.85 MB of heap completely full
of the longest answers possible, and the module itself about 0.26 MB.
Everything that comes back is a stranger's data: one 6 s budget for the
whole lookup, 256 KB a body, the final address must still be the host
asked, an id or key is used only if it is exactly an Archive item id or an
Open Library work key, and the page re-checks the answer (`cleanRead`,
`readerUrl`) before it builds the one `<iframe>` in the app. The title must
match (or be the part before a subtitle - "Frankenstein Unbound" is another
book) and an author's name must be in common. A failure is `{kind: 'none',
reason: 'unavailable'}` and the links still work.

**CSP:** the lab host's policy and this app's (`script-src 'self';
object-src 'none'; base-uri 'self'; frame-ancestors ...`) set no `frame-src`
or `default-src`, so the frame needed **no change** to either, and none
was made (tested). If the lab ever adds a `frame-src` or `default-src`, it
must allow `https://archive.org` or "Open the reader here" stops working
(the "Open in a new tab" link beside it still would).

### Buy this book

A sheet of plain links, each opening **the store's own page in a new tab**
(`rel="noopener noreferrer"`): Bookshop.org first (it pays independent
bookshops), Barnes & Noble, Amazon, and "A library near you" (WorldCat). No
payment in the app, no pixel, no store script (tested). The server builds
them (`Core.buyLinks`) into the member's view as `stores`.

**Affiliate ids are optional and come from two plain environment variables
on the `challenge` service** (not secrets - they are printed in every
link):

- `CHAPTER_BOOKSHOP_ID` - a Bookshop.org affiliate number (digits). Used
  only when the book has an ISBN: `https://bookshop.org/a/<id>/<isbn13>`.
- `CHAPTER_AMAZON_TAG` - an Amazon Associates tag (`something-20`), added
  as `&tag=`.

Unset (today: no affiliate account exists) or malformed, the links are
ordinary store searches. Read per request, so setting one needs no code
change: `gcpdeploy` with the variable added to the service. When any link
carries an id the sheet says so ("the store may pay Chapter a small
commission"). The host can add the book's **ISBN** under Club -> Edit the
book (optional, check digit verified) so the links open the exact edition.

## Visual redesign (2026-11-23): Erik's app style

Erik: "Chapter looks dated." A first pass in the website's navy look was
dropped the same day for **Erik's app style**, in Erik's own words: "Clean white
background, sleek like Apple, modern but professional, with soft motion that
makes it feel current. Very user friendly: big tap targets, plain labels,
simple icons, a bottom tab bar on phones, every main task one or two taps
from home. Phone first, then desktop." The rules are the ones Erik approved
for HOA Desk. **Presentation only**: no route, data, API or rule changed,
and every feature of the 2026-11-22 upgrade is where it was.

**The rules** (also at the top of the "Visual redesign" layer in `app.css`;
keep them when adding anything):

- A **white page**. Cards are white with a **1px hairline** (`#e5e5ea`) and
  **12px corners**; fields 10px; **pills** for buttons and chips. Gray fills
  (`--card2`, `#f5f5f7`) only where a group needs one (a reply under a
  note, a locked count, a quiet note). **No shadows**, except a barely-there
  one on what floats: the phone's bar, sheets, toasts, the welcome card.
- **One accent**: Chapter's plum (`#6d2b7a`, from its lab card), used
  sparingly - the primary button, links, the active tab, your bookmark and
  its meter. Status colours (ready, behind, locked, a question) are the
  only other colour.
- **Five type sizes** - 13, 15, 17, 20, 28 - plus the welcome headline;
  tight tracking on headlines; system fonts only. Note, reply and
  meeting-note text is 17px at 1.55, capped at 66 characters a line.
- **Spacing** on a 4/8 scale.
- **One icon set**: 24px, a 1.5px line, no fill (`ic()` in `app.js`, the tab
  icons in `index.html`, drawn by `.ico` / `.tabbar svg`). Emoji are only
  what readers chose or wrote: their avatar, their reactions.
- **Lists over boxes**: the club home's tasks, the readers, the welcome
  view's points are rows with hairlines between them.
- **Navigation is one element** (`#tabbar`, now inside the top bar's
  markup): on a phone a **slim floating translucent bar** at the bottom,
  48px buttons, only the active item labelled, a small accent mark under
  it; from 900px the same element is the **top navigation** in the bar,
  words only. It no longer becomes the shared sheet's left rail (the nav
  dropped the `dk-tabbar` class; `desktop.css` itself is untouched and still
  centres sheets and sets the shell's width).
- **The welcome view** is apple.com-like: one big centred headline ("Read
  together."), one line under it, two pill buttons (Start a club, Join with
  a code), two quiet links, a lot of white - then the example board.
- **Plain labels**: "Update my page", "Start a thread", "Vote for the next
  book", "RSVP", "Read it", "Buy this book", "Next meetup".
- **Soft motion only under `prefers-reduced-motion: no-preference`**: a
  view rises in once when the route changes (`arrive()` - never on a
  redraw or a poll), a sheet slides up, buttons ease on press. Nothing
  moves by itself; the page is complete at rest.
- **44px targets, 48px for primary actions**; nothing sideways at 390 or
  320px; text contrast 4.5:1 or better in both themes. The dark theme is
  designed too: a black page, `#1c1c1e` fills and sheets, the plum lifted
  to `#d9a8e6`.

**Every main task is one or two taps from the club home** (the Home tab,
which is the old Board): the bookmark card (Update my page, +1 chapter,
I've finished), then a list - the current chapter's discussion, the next
meetup **with RSVP on the row**, Vote for the next book, Read it, Buy this
book, and what is locked ahead - then Who's where. Counted in the browser
from the club home on a phone:

| Task | Taps |
|---|---|
| Update my progress (+1 chapter) | 1 |
| Open the bookmark sheet (chapter and page) | 1 |
| Read the current chapter's threads | 1 |
| Reply in the current chapter's thread (box open) | 2 |
| RSVP to the next meetup | 1 |
| Vote for the next book | 2 |
| "Read it" (is there a free copy?) | 1 |
| The book open in the reader | 2 |

`chapternow` (the discussion row) only sets the Notes tab's existing
chapter filter to the reader's own chapter and opens that tab - the server
has already left out everything past it.

**No inline style attributes.** The 129 `style="..."` the page used to
write into markup are gone: fixed ones became `data-u` utilities in
`app.css`; the ones worked out per reader (a place along the spine, a bar's
width, a ribbon's colour) are `data-w/-l/-b/-h/-c/-bg` attributes that
`dyn()` applies through the element's style object after each draw, checked
as a number or a six-digit hex first. (The lab's CSP was not changed.)

**How it is written**: the token blocks at the top of `app.css` were
replaced (same names, so `test/run.js`'s contrast test still reads them),
and one "Visual redesign" layer near the end overrides the rules above it.
Markup changed in `index.html` (the nav moved into the top bar, new icons,
labels Home / Discuss / Meet / Vote / Shelf) and in `app.js` (`viewFirst`,
`clubHead`, `viewBoard` and its task list, `ic()`, `dyn()`, `arrive()`,
labels). **Two assertions in `test/run.js` changed**, both pinning old
markup: the tab buttons' `min-height: 60px` is now 48px (a slim floating
bar), and `class="tabbar dk-tabbar"` became "the nav sits inside the top
bar, without `dk-tabbar`, and no markup carries a style attribute".

**Checked in headless Chrome over CDP**, phone first: 390 and 320 px, then
1440 px, light and dark - the welcome view, start, join, the made-up
club's five tabs, a four-reader club's home, threads (locked for the
reader at chapter 3, open for the others), meetups and meeting notes, the
vote, the shelf, the bookmark, club, meeting-note and buy sheets, "Read
it" and the Archive's reader in its frame, and the library: 72 views. No
console error or CSP violation, nothing past the edge at 390 or 320 px,
no style attribute in markup. **Text contrast was measured in the
browser** on every visible text node against the background it sits on:
the lowest is **5.68:1 in the light theme and 5.42:1 in the dark** (4.5 is
the floor). The run found one 41px-wide "Delete" link on a meeting note,
since given a 44px minimum. Not measured: emoji, and whatever the Internet
Archive draws inside its own frame.

## My library (2026-11-11)

Erik asked for a personal library in the book club app, all in one round:
add a book by ISBN from Open Library (manual entry when it finds nothing),
edition tags (special edition and/or signed, with an optional note), and
scanning the ISBN barcode with the phone camera, typing it when the camera
is refused. Erik chose **per person, across clubs**.

- **Whose.** Signed out, the library belongs to this phone: `libraries/p<…>`,
  where `<…>` is `sha256("chapter library v1:" + key)` - its own label, so it
  cannot be matched to the per-club `keyHash`es, and the key is never
  stored. Made by the first book (that is when the key cookie is minted;
  reading an empty library mints nothing). Signed in, it is the account's:
  `libraries/a<account tag>`, the same tag "keep my clubs" uses - never the
  email or account id. A signed-in reader with books still on the phone sees
  "Move them to my account" (`POST /api/library/keep`): the books (and their
  tags) are copied across, new ids where two would clash, and the phone's
  library is deleted. Signed out again, that browser is a stranger to the
  account's library. The move link for a club seat does **not** carry the
  library; the page says to keep it on a free account instead.
- **Nobody else's.** The library id comes only from the request's own
  cookie or session, never from the URL or body, so there is no route that
  could name someone else's; another reader's book id is a 404 (tested,
  including `__proto__`). The library never appears in a club, and clubs
  never see it.
- **The lookup** (`GET /api/isbn/:isbn`, `lib/openlibrary.js`): ISBN-10 or 13
  typed however, checked by its check digit (a wrong one is a 400 that says
  why - "one digit may be off"), always kept as ISBN-13; only 978/979 are
  books. The server asks `openlibrary.org/isbn/<isbn>.json`, then the
  author (or the work, then its author, or the edition's "by" line). **Open
  Library's answer is untrusted**: one 6 s budget for the whole lookup
  (`AbortSignal.timeout`, no timer), 256 KB per body, the final URL must still
  be openlibrary.org, a key is followed only if it is exactly an author or
  work key, fields go through the club cleaners, and a cover is only
  `https://covers.openlibrary.org/b/id/<number>-M.jpg`. Not found and
  unavailable are both a 200 (`found: false, reason`) with the ISBN, and the
  page opens manual entry with it filled in and says which. Cached in memory:
  finds a week, misses an hour, failures never. 60 lookups per address an
  hour. `have` says how many copies of that ISBN the asker already has.
  The page never calls Open Library itself; covers load from its cover
  host (`referrerpolicy="no-referrer"`). This reverses the earlier "book
  search is new infrastructure for a daily drop": it is an ask, not a drop,
  and it needs no key, secret or new service.
- **Edition tags.** `special`, `signed` (only `true` is true) and `note`
  (one plain line, 200 characters). A note belongs to a tagged copy: with
  neither tag it is dropped. A tag change writes exactly three keys.
  Adding the same ISBN twice keeps both copies (a signed one and a reading
  copy is the point); the add sheet says "You already have a copy".
- **Scanning.** `getUserMedia` for the back camera, no microphone, read on
  the phone: `BarcodeDetector` where the browser has it, otherwise
  `ChapterLibrary.decodeFrame` - an EAN-13 reader in `public/library-core.js`
  (iPhone Safari has no BarcodeDetector). Rows across the middle, then
  columns; smoothed and raw; either direction; ink spread measured on the
  guard bars and taken out; a read counts only if its check digit holds,
  and only after it is seen twice (two lines of one frame or two frames).
  An EAN that is not 978/979 says so. The camera stops the moment a book is
  read, the sheet closes or another sheet opens (`stopScan`). Refused
  (`NotAllowedError`) or missing (no `mediaDevices`, not a secure context):
  the ISBN sheet opens and says so, with how to allow the camera next time.
  Frames never leave the phone; only the ISBN is sent.
- **Limits.** 500 books a library; 240 library writes per library in 10
  minutes; a phone's library nobody opens in **400 days** (as long as the
  key cookie lasts) is deleted by the read that finds it. An account's is
  kept.

`public/library-core.js` is the rules file (UMD, `window.ChapterLibrary`,
loaded after `chapter-core.js`): no clock, no dice, no network, no storage,
like the core. Tests: `test/library.js` (ISBNs, entries and tags, the
barcode reader on drawn barcodes from 1 to 8 px a module through ink
spread, blur, noise, uneven light and low contrast, a damaged code never
read as another book, frames held sideways; then over HTTP against a fake
Open Library that fails the test if anything else is asked: found, author
from the work, not found, an error, a timeout, a body too big, garbage, a
redirect elsewhere, hostile fields and keys, the cache, bad ISBNs, the lookup
limit, privacy between two phones, tags, manual entry, cross-site writes,
the 500 cap, deleting the library, moving a phone's books onto an account,
the 400-day expiry, and the page's own promises). **Not proven by a test:**
a real phone camera and a real `BarcodeDetector` - the page's capture loop
was not driven in a browser (the build machine's sandbox kept headless
Chrome off the network), so try it on an iPhone and an Android phone before
relying on it.

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
npm test        # the rules first, then end to end over HTTP under a /chapter mount;
                # then test/library.js (the library, with a fake Open Library)
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

`test/run.js` (42 tests; the nine added 2026-11-22 are threads, meeting
notes, page-and-chapter, buying, the reading lookup against a stand-in for
Open Library and the Archive that fails the test if anything else is
asked, older clubs, the locked thread over HTTP, caps and hostile fields,
and reading and buying over HTTP - no test reaches the network). One
existing test changed on purpose: the made-up club now has two meetings
(the last one, with its notes, and the next), so "one meeting" became "a
past one and the next". The original 33: text and hostile input (markup, bidi, zero-width,
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

**The 2026-11-22 upgrade** was rendered in headless Chrome over CDP
(Playwright is not on that machine) at 390 and 1280 px, light and dark: a
four-reader club at chapters 3, 12, 14 and finished - the board with its
glance and pages, a locked thread and a locked meeting note for the reader
at chapter 3 (checked absent from the page's text), the same threads open
for the others, a reply posted, the meeting-note and bookmark sheets, the
buy sheet, "Read it" against the real Open Library and Internet Archive
(Frankenstein: found, and the Archive's reader loaded in the frame), "+1
chapter" from the reader, the ISBN field, and the made-up club's board,
notes, meeting and reader. No console error or CSP violation, nothing
past the edge at 390 px, every visible control 44 px or more - which found
two older misses, fixed here: the meeting card's "Map" link and the
desktop tab buttons (42 px in the shared `desktop.css`, raised from
`app.css`).

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
  reactions: {<mid>: emoji}, createdAt}`. Since 2026-11-22 also a reply
  (`kind: reply`, `re: <note id>`, `at` = the thread's chapter) and a
  meeting note (`kind: minutes`, `meet: <meeting id>`, `meetDate`,
  `decision`). Optional on a club since then: `members.<mid>.alt`,
  `book.isbn`, `shelf.<bid>.isbn`. Older documents have none of these and
  need none.
- `accounts/<tag>` - `{clubs: {<club id>: <member id>}, updatedAt}`, only
  for a signed-in member who asked.
- `libraries/p<hash of key>` or `libraries/a<account tag>` - `{books: {<bid>:
  {isbn, title, author, pages, cover, source: openlibrary|manual, special,
  signed, note, addedAt}}, createdAt, updatedAt, v}`. See "My library".

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
`POST notes` (a note or question; with `re` a reply; with `meet` a meeting
note), `DELETE notes/:nid`, `PUT notes/:nid/react`, `GET read`, `PUT
meetings/:mt/rsvp`, `POST noms`, `DELETE noms/:nid`, `PUT ballot`, `PUT
rating`, `GET shelf/:bid/notes`, `POST move`, `DELETE me`. Host: `PATCH
book`, `POST|PATCH|DELETE meetings[/:mt]`, `POST vote/close`, `POST
vote/reopen`, `POST next`, `POST host`, `DELETE members/:mid`, `POST code`,
`DELETE /api/c/:id`. Signed in (free): `GET /api/account/clubs`,
`PUT|DELETE /api/account/clubs/:id`. Metered: `POST /api/ai/questions`.
The shared account at `/api/auth`. The library (this phone's, or the
signed-in account's): `GET /api/isbn/:isbn`, `GET|DELETE /api/library`,
`POST /api/library/books`, `PATCH|DELETE /api/library/books/:bid`; signed
in, `POST /api/library/keep`.

## What is deliberately not built

- **Notifications** ("notes unlocked", "the vote is closed"): no sender on
  this platform; the iPhone app is where they belong.
- **Book search for a club's book** (title, author and chapter count from an
  ISBN): the personal library looks books up (above), but a club's book is
  still typed - Open Library has page counts, not chapter counts, and
  chapters are what the spoiler rule runs on. The share card and shelf
  still draw a letter on a spine.
- **Page-to-chapter mapping** for mixed editions (see "Chapters over
  pages"). A reader can now show their page beside their chapter, but it
  unlocks nothing.
- **Fetching and caching public-domain text here** (Gutenberg, Standard
  Ebooks): their terms point programs elsewhere, and the Archive's
  embeddable reader does the job with no text passing through the lab. See
  "Read it".
- **Payments, a cart, price comparison, tracking of who tapped Buy**: the
  button is a link.
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
