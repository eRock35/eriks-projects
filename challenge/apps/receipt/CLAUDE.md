# For Claude: Receipt

Every meeting gets a receipt. A team lead, a founder, an agency PM or a shop
owner with a weekly huddle sets up a **meeting**: who is in the room as **role
bands** with hourly rates (Exec $200, Manager $110, IC $85, or one blended
rate, optionally ×1.3 loaded — never names with salaries), the booked length,
a **timeboxed agenda** (items with minutes and a lead) and, optionally, the
attendees' first names so actions can have owners. When it starts, a **live
meter** ticks in dollars and person-hours with comparisons ("≈ 1.4 pairs of
good headphones", a ping at "the price of an iPad"); the current item has a
**ring** that turns red with the overrun in dollars ("This item is $38 over"),
a chime and a buzz. **Decision / Action / Park it** are one tap each, and cost
per decision updates live. The room opens `r/<code>` (QR on the facilitator's
screen) with **no account**: tap "could have been an email", give the classic
**ROTI** vote (0–4), and — if the facilitator turned it on — play **buzzword
bingo** on a card dealt for that browser. End prints a **thermal receipt**:
duration, headcount and cost by band, planned vs actual per item with
overruns, decisions, actions, parking lot, cost per decision, the room's ROTI
and email votes, the bingo winner's emoji, and **TIME GIVEN BACK** when it
finished early. Tear it off, save a PNG, copy it as text, or share a
**numbers-only** link. Then: a **recap** (free from the log, or written by a
model from notes, a transcript or one whiteboard photo), **the next
occurrence** with last time's open actions as **loose ends**, a **meeting-tax
audit** of the recurring meetings (Keep / Shrink / Kill, saved per year) and a
**scoreboard**.

Built 2026-09-25 as the eighth of Erik's lab drops, after Spar, Snapquote,
Chaser, Rave, Pop Quiz, Glowup and Booth. **Staging only**: no custom domain
until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab — `challenge/apps/receipt`,
served at `challenge.strongtechnicalconsulting.com/receipt/`, data in
`receipt_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

Meetings are the most expensive thing on a team's calendar that nobody sees a
bill for: eight people in a weekly hour cost about $40k a year in loaded time.
Agendas say "sync on Q4", items run over, nobody writes down what was
decided, and the recurring meeting nobody would book today keeps going
because cancelling it feels political. Shopify put meeting cost into its
calendars in 2023 because seeing the price changes behaviour; a small team
has nothing like it, and no record of whether the hour was worth it.

Receipt puts a price and a verdict on every meeting — and leans on the
positive side on purpose: **time given back**, an on-time streak, the room's
own vote. The dollar total alone would read as a manager shaming colleagues.

**Who pays.** Nobody, for most of it: the meter, the rings, the log, the room,
bingo, the receipt (link, PNG, text), the free recap template, the audit and
the scoreboard never call a model and are free forever. Sharpening an invite
and writing a recap are about a cent each on Haiku (a few cents with a
photo). The membership buys the better model.

**How it becomes an iOS app.** The meter is a Live Activity and Dynamic
Island ticker (dollars and the current item's time left on the lock screen),
an Apple Watch tap when an item runs over, EventKit filling the audit from
the real calendar on-device (no OAuth), the receipt straight to the share
sheet as an image, the room as an App Clip from the QR code, a "time given
back this week" widget, and "Hey Siri, start the meter". The data model does
not change.

**The honest risk.** Every dollar is an **estimate** from role bands, and the
page says so on the ticker, the receipt and the share. It measures time, not
value — ROTI is the room's signal, and a small room's vote is a small sample;
one vote per browser is gameable by anyone who clears cookies. The web
version has no calendar, so recurring meetings are typed by hand. Meeting
cost calculators exist as one-page toys; retention depends on the audit, the
recap and the loose ends, not the ticker's novelty.

## The decisions that matter

- **One rules file, run twice.** `public/rules.js` is UMD: the page loads it
  as `window.ReceiptRules`, the server `require`s it. It holds setup
  validation, the meter, the agenda maths, comparisons and milestones, the
  log validator, the heat clock, ROTI, bingo (deal and line check), the
  receipt and its text form, the recap template, the audit and the
  scoreboard. The facilitator's laptop, the room's phones, the shared link
  and the tests all compute the same numbers from the same code.
- **Timestamps only; the server never runs a timer.** A meeting stores
  `startedAt`, `pauses: [{at, until}]`, `marks` (the meeting time, in ms, at
  which each agenda item was closed) and `endedAt`. Elapsed = end-or-now −
  start − pauses; each item's actual time is the difference of its marks.
  A locked phone, a reload or a second device lands on the same number. Next
  and End are one merge each, and the "now" in them is the server's. End may
  also say when, for a meeting nobody ended (`{ at }` in meeting-time ms):
  clamped between the last closed item and now, so it can only shorten the
  meter, and stored as the wall-clock moment the meeting had run that long
  (`R.wallAt`). The live page offers "End it at the booked time" / "at the
  last logged item" once a meeting is 2 h past its booking or is opened on a
  later day than it started - a laptop closed mid-meeting used to print a
  16-hour receipt that nothing could correct. This is also what `cpuIdle:
  true` needs: nothing works after a response is sent, and the room's page
  polls (every 10 s) rather than being pushed to.
- **Bands, not people.** The room is `people: [{band, rate, count}]`. Labels
  for action owners are a separate list with no rate, so no name can ever be
  paired with a salary. The receipt credits bingo by an emoji from a fixed
  list, not a name.
- **Locked once it starts.** After Start, the room, the rates, the booking and
  the agenda are what the receipt is computed from, so edits to them are 409;
  the title, labels, outcome and bingo can still change. The sharpener is
  refused (409, before any spend) once the meeting has started.
- **One document per row where two people write.** Each vote is
  `votes/<browser id>`; each logged item is `log/<id>`. The meeting carries
  atomic counters (`nDecision`, `nAction`, `nParking`, `voterN`, `rotiN`,
  `rotiSum`, `emailN`) moved by the *difference* when a voter changes their
  mind, so a changed vote never counts twice; the counters feed the list and
  the scoreboard without reading subcollections, and the receipt reads the
  vote documents themselves. The tests fire a dozen phones' votes at once and
  check the documents and the counters agree.
- **The room needs no account.** An opaque `receipt_vid` cookie (22 random
  url-safe characters, HttpOnly, no IP, no user agent) is the voter id — one
  voice per browser, changeable until a day after the end. The room sees the
  title, the ticker's inputs (bands, rates, counts, timestamps) and agenda
  titles and minutes — never attendee labels, agenda owners, the log, the
  invite or the outcome. Room codes are Booth's format (8 of 32 unambiguous
  characters, rejection-sampled); wrong codes are counted per address in
  memory - 40 DISTINCT wrong codes per 15 minutes, then even the right one
  waits. A dead code polled again counts once: after a reset, every phone
  still open on the old code polls it, and counted per request a room on one
  office Wi-Fi locked itself out of the new code in under a minute (the
  room's page also stops polling a code that 404s and says it changed). New
  voters are capped at 60 per address per 15 minutes (`newVotersPerIp`) -
  under a room's 300, so one address cannot fill a room and set its verdict;
  above a typical room behind one office NAT, and a bigger one on one address
  fills over two windows. That slows stuffing, it does not stop it. Resetting
  the code kills the old one at once.
- **Bingo is checked by the same rules on both sides.** A card is dealt from
  `meetingId:browserId` by a seeded shuffle (FNV-1a + mulberry32) of 48
  clichés with a free middle. The page keeps the marks; a claim sends the
  marked positions and the server checks them for a line with the same
  `bingoLine` the page uses. The card is dealt from `meetingId:browserId`
  only for display - nobody can verify what was said in the room, so the
  check is the shape of the line, not the squares on it. The first
  confirmed bingo is stored on the meeting (`bingoFirst`) and is the one the
  receipt credits. It is **off by default** — the facilitator's call.
- **Every model call is a forced tool** (`sharpen_agenda`, `write_recap`)
  behind `requireUser, requireBudget, requireDailyCap` (`spend` in
  `server.js`), then the ownership 404. An empty wallet 402s and a stranger
  404s with no model call; the tests count usage rows to prove both. Only
  the app's own errors (`M.httpError`, marked `expose`) reach the page with
  their status and words; anything else - the Anthropic SDK's errors carry a
  `.status` and the provider's raw JSON too - is logged and answered 502
  (503 when the provider is overloaded or rate-limiting) with the route's
  fallback. A provider 401 passed through used to tell a signed-in member to
  sign in.
- **The sharpener proposes; Apply is the ordinary edit route.** Validated:
  markup stripped, titles bounded, at most 8 items, minutes scaled down (then
  trailing items dropped) to fit the booked length, owners only from the role
  bands actually in the room, `attendeeBands` likewise, the verdict one of
  `meeting | split | email` — and a `split`/`email` without a usable written
  update stays a meeting. Numbers, weekdays, months, links and addresses the
  invite never gave become `[add: …]` (`guardFacts`, Booth's guard), and the
  page lists what was taken out. The guard matches WHOLE tokens - "decide"
  does not license Dec, "month" not Mon, 25% not 5%, $1,500 not $150 - and a
  full day or month name is a date in any case ("by friday"). Each item's
  minutes are capped at the booking and at the 240 an item may have, and
  text is fitted back inside its limit after gaps are added (never cutting a
  gap in half), so what the sharpener proposes is exactly what Apply's edit
  route accepts.
- **The recap cites every item, and owners and dates must be earned**
  (`ai.validateRecap`). An item is either one of the meeting's logged items
  (`source: log`, `ref` its number — then its words, owner and due date are
  the log's own: a citation says which item it is, not what the model printed,
  and a paraphrase once turned "Pause the paid social test" into "keep it
  running and scale it up") or it carries the **exact words** it came from,
  and it is dropped unless that quote is a whitespace-, case- and
  curly-quote-folded substring of the pasted notes (or of the whiteboard's
  transcription). An owner from the notes survives only if they are one of the
  typed attendee labels **and** they took it on: the line's speaker is them
  and the words are first-person ("I'll…", "I can…", "leave it with me", "let
  me" only with a verb of doing - "let me know" hands it to someone else), or
  the quote assigns it ("Sam will…", "Sam to…"), and the words right after are
  not a refusal ("I will not…", "I can't…", "Sam will never…"). Otherwise it
  reads `[owner?]`. A due date survives only when its words (`dueText`) are in
  the quote and the date is within a year of the meeting. "Next meeting" must
  be in the notes. The summary goes through `guardFacts`. The fake model's
  `INJECT` answer exercises every one of these.
- **Notes and photos are read once and kept nowhere.** A whiteboard photo is
  shrunk in the browser (1600px JPEG), checked by magic number and size
  *before* anything is spent (`lib/photo.js`, 400), read by the model and
  dropped with the request; unreadable with nothing else to go on → 422. The
  recap route's 6 MB parser mounts **after** the sign-in, budget and
  ownership checks (`ownerOnly`), so a stranger's upload is never parsed;
  everything else is 128 KB. The tests dump the store before and after.
- **A recap is a proposal.** Nothing is saved and nothing is sent: the page
  offers Copy and a recipient-less `mailto:`. There is no mail service.
- **The share link is frozen and numbers only.** `M.shareCard` builds it
  field by field from the receipt: no title, no agenda item names ("Item 2"),
  no decision, action or parking text, no labels, no notes — counts, times,
  money, ROTI, the verdict and the bingo emoji. One token per meeting (22
  chars from 16 random bytes), only once it has ended; Update re-freezes the
  same link, Revoke deletes it. `/s/*`, `/r/*`, `/api/shared/*` and
  `/api/room/*` answer with `no-referrer` and `noindex`; `/s/*`, `/r/*` and
  `/api/shared/*` are GET-only (405 otherwise). Both public pages are the app
  itself with `<base href="../">`.
- **Heat, not blame.** An open action warms from its age against its due date
  (or a week): warm for the first half, hot for the second, scorching when
  past due, dropped a week after that — computed on every read. "Past due"
  is by the person's own calendar day (`x-local-date`), not 23:59 UTC, which
  turned an action scorching at 5pm in California on the day it was due.
  Open actions
  from earlier meetings in a **series** (`seriesKey`, set when you "Set up
  the next one") come back at the top of the next occurrence as loose ends,
  tickable from there. Dropped actions are counted for the team only, never
  listed by person on the scoreboard.
- **No model call and no write for a signed-out visitor.** The sample
  (`lib/demo.js`): an invented "Weekly Marketing Sync" — 1 Exec, 2 Managers,
  4 ICs ($760/h), a 45-minute agenda of five items and a vague invite —
  played in the browser at 60× from a script: the log fills, two people tap
  "email", the campaign review runs 18 of 15 minutes ($38 over), 🦊's card
  fills its middle row, five votes arrive in the wrap-up, and it ends at 38m
  22s: **$486.00, 3 decisions at $162, ROTI 2.6/4, TIME GIVEN BACK 6 min**
  (the pitch said 4 min; 4 min with $486 is not reachable with seven people
  at the default band rates, so the dollars were kept). Plus a six-meeting
  audit (Weekly all-hands: $38,400/yr), a month of scoreboard, and the
  sharpener's and recap writer's example outputs written by hand and passed
  through the real validators — the tests assert they remove nothing.

### Numbers

Cost = Σ rate × count (× 1.3 if loaded) × elapsed hours. Person-hours =
headcount × elapsed hours. An item's overrun $ = its overrun × the room's rate.
On time = within a minute of the booking; TIME GIVEN BACK = booked − actual
when that is at least a minute (rounded down), and person-minutes given back =
that × headcount. Cost per decision is none — "NO DECISIONS" on the receipt —
when nothing was decided. ROTI is the mean of 0–4 votes to one decimal.
Verdict: a majority of voters (2+) saying email → "could have been an email";
else ROTI ≥ 3 worth it, ≥ 2 worth it just, < 2 costly; no votes and no
decisions → "a status update could have done this".

Audit: a year is 240 daily, 96 twice-weekly, 48 weekly, 24 fortnightly or 12
monthly occurrences. Shrink offers half the length rounded to 5 (not under
15), one step less often, and no bands dropped until chosen; a shrink never
lengthens or makes it more frequent, and at least one band always stays.
Saved: kill = the whole annual cost, shrink = the difference, keep = 0.

Scoreboard: the last 8 weeks (Monday-start, by the browser's own date sent as
`x-local-date`), the current and best on-time streak, total time given back
(clock and person-hours), ROTI for the last 10 meetings with votes, the most
expensive meeting this month, audit savings. Badges: First Receipt,
Zero-Overrun Week (2+ meetings in a week, none over), Killed a Meeting,
Cost-per-Decision under $50.

Models: free tier Haiku 4.5, members Sonnet 5, via `identity.planFor` — the
same split as the siblings. A sharpen is ~800 input / ~400 output tokens; a
recap similar, plus ~1.5k input for a photo.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8099/receipt/
npm test        # pure rules first, then end to end over HTTP under a /receipt mount
```

`RECEIPT_MEMORY=1` and `RECEIPT_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE` set) — in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `RECEIPT_COLLECTION_PREFIX` (set
to `receipt_` by the lab host) prefixes every top-level collection; the default
database is `challenge`. The fake model answers from the prompt's own fields
and refuses any call that does not force a tool. Triggers: `INJECT` in an
invite (markup, a link, an invented weekday and percentage, an exec owner
where there is none, minutes over the booking); `EMAIL` (verdict email with an
update); `EMPTY` (nothing usable → 422); `INJECT` in recap notes (a quote
nobody wrote, a non-attendee owner, an owner who never took it on, a deadline
the notes never gave, markup and an invented figure); a photo whose bytes
contain `BLANK` is unreadable, `BOARD` a whiteboard with a decision on it;
`UPSTREAM401` (any `UPSTREAMnnn`) anywhere in a prompt fails the call the way
the SDK's APIError does, for the error-handling tests.

`public/qr.js` is Kazuhiko Arase's MIT "QRCode for JavaScript" (the copy
carried in qrcode-terminal), bundled into one UMD file; the test checks the
finder patterns, and the bundle was checked module-for-module against the
original when it was made.

## Data (Firestore: `receipt_*` in the lab database `challenge`)

- `meetings/<uid>/items/<id>` — the setup (title, invite, outcome, mode,
  `people: [{band, rate, count}]`, loaded, bookedMinutes, `agenda: [{title,
  minutes, owner}]`, labels, bingo), seriesKey, code, day (the browser's date
  at Start), startedAt, pauses, marks, endedAt, the counters above,
  bingoFirst, shareToken, sharedAt, createdAt, updatedAt. Under the owner's
  uid, so nobody else's id can name it — every route is a 404 for anyone else.
- `meetings/<uid>/items/<id>/log/<lid>` — kind `decision | action | parking`,
  text, owner (a label or ''), due, at (meeting ms), createdAt, doneAt.
- `meetings/<uid>/items/<id>/votes/<browser id>` — roti, email, handle,
  bingoAt, line, createdAt, updatedAt. No IP, no account.
- `recurring/<uid>/items/<rid>` — title, minutes, cadence, mode, people,
  loaded, decision `keep | shrink | kill | null`, shrink `{minutes, cadence,
  drop}`.
- `codes/<CODE>` — `{uid, mid}`: the room-code lookup.
- `shares/<token>` — `{uid, mid, createdAt, card}`: the frozen public receipt.

Limits (`lib/meetings.js` LIMITS, plus `rules.js`): 300 meetings and 40
recurring rows a person, 100 logged items and 300 voters a meeting, 12 agenda
items of 1–240 minutes inside a 5–480 minute booking, 200 people per band and
300 in a room, rates to $2,000/h, 30 labels of 30 characters, titles 80, log
text 200, invite 2,000, notes 20,000. JSON bodies 128 KB except the recap
route (6 MB, after the gates; image 4 MB decoded). Notes over 40,000
characters are refused (400) before any cleaning. `clean()` and `cleanText()`
cut their input to four times their limit BEFORE any pattern runs, and the
tag pattern stops at the next `<`: a run of `<` with no `>` used to cost
O(n²), and one free account's request held the lab's whole process - every
app in it - for seconds (hours, scaled to 6 MB). 60 new voters per address
per 15 minutes.

Deleting a meeting deletes its log, votes, room code and share link.

Accounts are the shared identity (`identity` database), mounted at `/api/auth`
— one account and one $2 credit across the lab and every app.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/demo`, `/api/shared/:token`, page
`s/:token`, and `rules.js`, `qr.js` (static). The room, no account:
page `r/:code`, `GET /api/room/:code`, `POST /api/room/:code/vote|email|bingo`.
Signed in: `GET /api/me`, `GET|POST /api/meetings` (POST with `repeatOf` for
the next occurrence), `GET|PUT|DELETE /api/meetings/:id`,
`POST /api/meetings/:id/start|pause|resume|next|end`,
`POST /api/meetings/:id/code`, `POST /api/meetings/:id/log`,
`PUT|DELETE /api/meetings/:id/log/:lid`, `GET /api/meetings/:id/pulse`,
`GET /api/meetings/:id/receipt`, `POST|DELETE /api/meetings/:id/share`,
`GET|POST /api/recurring`, `PUT|DELETE /api/recurring/:rid`,
`GET /api/scoreboard`. Metered: `POST /api/meetings/:id/sharpen`,
`POST /api/meetings/:id/recap` (optional whiteboard photo).

## Ideas not built yet

- **Per-band ROTI** for the audit's Shrink ("drop the bands whose ROTI is
  low"): votes are anonymous today; asking voters their band would make it
  possible without naming anyone.
- **Talk time** is deliberately left out — it feels like surveillance.
- **Calendar import** for the audit — OAuth is off the table for a lab drop;
  EventKit in an iOS build is the honest path.
- **A nudge when an action turns scorching** — needs a sender (push or
  email), which the platform deliberately doesn't have.
- **Team view**: several facilitators pooling their scoreboards (Booth's
  join-code team model would carry over).
- The Margin-app grafts offered with this pitch (starter kits, lock and
  re-solve, price freshness, Keep / Rework / Cut on a menu matrix) belong to a
  food-cost app, not to meetings, and were not built here.
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
