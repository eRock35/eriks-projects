# For Claude: Tada

Morning and bedtime routines a child taps through - out the door on time,
into bed without the battle. For parents and carers of children about 3 to
10. **Kid mode** fills the screen with one step at a time (a huge picture,
the step's name in big friendly type, progress dots, a gentle ring timer, a
96px **Done!** button, a soft chime, optional read-aloud, a sticker at the
end); the **parent view** shows each child at a glance ("Maya: 4 of 8 - on
track for 7:51 PM", "about 6 minutes behind") with an editor, templates, a
**sticker book** with a gentle streak, a **clocks-change helper** that eases
bedtime over the days before daylight saving changes, a **fridge chart** to
print and a **"Start bedtime" calendar reminder**. Up to four children, **side
by side** on a tablet. Free and on the device; sign in (free) to share it
between a parent's phone and the family tablet; two metered AI helpers.

Built 2026-10-28 as an **everyday** drop: Canon (2026-10-27) was a business
one, so today was the other kind. **Staging only**: no custom domain until
Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/tada`,
served at `challenge.strongtechnicalconsulting.com/tada/`, data in `tada_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it was picked (everyday life)

- **An everyday pain every family with young kids has, twice a day.** The
  morning scramble ("shoes! bag! teeth!") and the bedtime battle, where a
  parent ends up nagging through the same eight steps every night.
- **The incumbent is the paper reward chart on the fridge.** It does not know
  the time, cannot say "you have 6 minutes", is lost when a child has a
  second home or a sitter, and stops working the week the stickers run out.
  Tada keeps what works about it (pictures, ticks, stickers) and adds the
  clock, and still prints one for the fridge.
- **Timely.** US clocks go back on **Sunday 2026-11-01**, and young
  children's sleep is thrown by it for days. Tada finds the change from the
  device's own time zone and offers to ease bedtime over the four days
  before - which is why it shipped this week.
- **Free on the device.** Every feature works signed out, offline, with no
  request at all.
- **It could be an iPhone/iPad app** (below).

**Not a repeat:** Pawlog is pet care for a household, Chorus is chores
between adults, Rep is a lifting log. Nothing in the lab or the portfolio
walks a child through a routine.

**Who pays.** Almost nobody. Setup, templates, kid mode, side by side,
stickers and streaks, the clocks plan, the print chart and the .ics are free,
need no account and make no request. A **free** account syncs the family to
the family tablet. The two metered things (Haiku for the free tier, Sonnet
for members via `identity.planFor`) cost a cent or two each.

**How it becomes an iPhone/iPad app.** Guided Access-style locking of kid
mode, local notifications at the start time (no server needed), a Live
Activity counting down to lights-out, widgets ("Maya: 4 of 8"), Screen Time /
Family Sharing for the second parent instead of an account, and AVSpeech for
read-aloud with a chosen voice.

## The decisions that matter

- **One rules file, run three times.** `public/tada-core.js` is UMD
  (`window.TadaCore` in the page, `require` in the server and tests): the
  emoji set, stickers, templates, times, status, progress, stickers and
  streaks, the clocks helper, the .ics, every cleaner and both AI briefs and
  answers. **No clock and no dice** (tested: no `Date.now()`, `new Date()` or
  `Math.random`): "now", "today", the time zone and every new id are handed
  in. No lookbehind regexes anywhere (older iPhones cannot parse them).
- **The emoji are a curated set of 65** (`EMOJI`: emoji, label, words), all
  for children, no joined sequences. A step's emoji must be one of them
  (`emojiOf`, which also accepts a missing variation selector); a name finds
  the best one (`emojiFor`, longest phrase wins). The model's tool offers
  exactly this set as an enum, and the answer is cleaned against it again.
- **Templates** (`TEMPLATES`): Morning school day, Weekend morning, Bedtime,
  Bath night, each in three ages (3-5, 6-8, 9-10): potty and story time for
  the littlest, packing their own bag for the biggest; lights-out 7:30, 8:00,
  8:45. Step names speak to the child ("Brush your teeth") and never assume a
  gender (tested on every template and on every quoted string in the page).
- **Times**: `timesFor` works the start back from the done-by time ("Start by
  7:25 PM"), `fmtTime` follows the device's 12/24-hour clock. `status` is the
  one gentle line per routine: "Starts 7:25 PM", "4 of 8 - on track for 7:51
  PM", "about 6 minutes behind" (amber, never red), "All done", and after 90
  minutes past done-by just "3 of 8 done". The Today view orders routines due
  now first, finished next, past last.
- **Kid mode** (`#kid`, a full-screen dialog): one step, huge emoji, progress
  dots, a ring that fills over the step's minutes and then just says "Take
  your time" in a calm colour (never a buzzer, never red), a 96px Done!, "Back
  a step", optional "Say it". Each Done! is a pop, a "Great job!" and a soft
  WebAudio chime (sine notes at low volume, made inside the tap; a Sounds
  switch); the last one is confetti, an arpeggio and a sticker. Under reduced
  motion: no confetti, no pops. Read-aloud (`speechSynthesis`, off by
  default, per device) says `sayFor(step)`: "Time to brush your teeth!",
  "Time to get your coat on!", "It's story time!". The screen stays on
  (Wake Lock). Morning routines get a sunrise sky, bedtime a calm night sky.
  **There is no link in kid mode** (tested).
- **Leaving kid mode is a two-second press-and-hold** of the small corner ✕
  (a ring fills as you hold; Enter or Space held works the same). A tap only
  shows "Grown-ups: press and hold" and an **accessible alternative**, a
  grown-up question ("What is 4 + 3?", four big choices) - the same kind of
  parental gate Apple asks of Kids-category apps. A screen reader's double-tap
  is a tap, so it gets the question. After a hold the next 600 ms of clicks
  are swallowed, so the finger that held does not press whatever is under
  it. The browser's back gesture cannot leave kid mode either.
- **Several children** (up to 4): a "Whose turn?" picker, and **side by side**
  (tablet and desktop, 900px+) with a column per child, each with its own
  current step and Done!, the clock in the corner.
- **Stickers and streaks**: a finished routine earns a sticker chosen by a
  hash of (child, day, routine) - the same on every device, no dice. A streak
  counts **routine runs**: each routine on the days it runs, from the day it
  was added; a run due today and not finished yet is pending (neither counts
  nor breaks). Current, best and total, per child, one child at a time; the
  copy is a nudge ("Nice and steady. Stickers are for showing a grown-up -
  not for racing anyone"), and there is no leaderboard between siblings.
- **Setup** (the first run, put real effort into): a hero with a mock of kid
  mode and **Try it** (a made-up five-step bedtime with one-minute steps,
  tapped through to the sticker; never saved), then three skippable steps -
  Morning / Bedtime / Both; a first name or nickname ("stays on this device"),
  an age and an animal; "Out the door by" / "Lights out by" - and the
  ready-made routines appear with "Start by ..." worked out.
- **The editor**: name, kind, done-by, weekdays, and steps with a picture
  from the set, a name, minutes 1-30 (steppers), reorder by drag (the ⋮⋮
  handle, pointer events; arrow keys on the handle) and by ↑/↓ buttons, ✨
  "Make it a game" and remove (behind ⋯ on a phone). A new step's picture
  follows its name until one is picked. 20 steps and 6 routines per child at
  most.

## The clocks-change helper

`nextChange(nowMs, tz, days)` finds the next daylight-saving change in the
device's zone (`Intl...resolvedOptions().timeZone`) **with Intl alone**: the
zone's offset at an instant comes from `formatToParts` (no tz database, no
hard-coded dates), stepped every six hours across 60 days, then halved to
the minute. It returns the instant, the offsets, the local day, the wall
clock before and after ("At 2:00 AM they go back to 1:00 AM") and the kind.
None coming (most of the world) is null.

`clockPlan(change, today)` eases into it: lights-out (and, only if the parent
turns it on, the morning routines) move **15 minutes a day over the four days before** -
**later** when the clocks go back, **earlier** when they go forward - so on
the day itself the usual time on the new clock feels normal to the child. Made
with fewer days left, the same total over the days there are (5-minute
steps); on the day itself, no plan. A 30-minute zone (Lord Howe) takes two
days. The parent sees the plan day by day first, with **Move mornings too**
(**off by default**, 2026-10-28 review: the days before a change include
school days, and moving out-the-door would make a child late); **Use this plan** stores it in the
family settings and the app applies it by itself (`shiftFor`) on those days,
with a 🕑 badge on each moved routine, an Undo in the toast and an "Undo the
plan" on the card. It expires on the day of the change. "Not now" is
remembered for that change only.

Tests, with fixed clocks and fixed zones: America/New_York on 2026-10-28
(back, Sun Nov 1, +15/+30/+45/+60, the compressed plans, none on the day),
Europe/London 2027-03-28 (forward, -15 to -60), New York's spring change,
Tokyo and UTC (none), Lord Howe (30 minutes), and the same answers with the
machine's own `TZ` set to three other zones.

## Print and calendar

- **The fridge chart**: `#print` is filled and `window.print()` called; the
  print stylesheet hides everything else and draws the routine's emoji, name,
  the child, the times, every step with its picture and minutes, and a row of
  tick boxes for Monday to Sunday (dashed on days it does not run) plus a star
  for a sticker. Sized for the smaller of **Letter and A4** (186 x 255 mm
  inside 12 mm margins); rows are roomy up to 8 steps and shrink in two
  stages so 20 still fit. Checked by printing both to PDF: one page each.
- **"Add 'Start bedtime' to my calendar"** downloads an .ics built on the
  device (`buildIcs`): one weekly event, `RRULE:FREQ=WEEKLY;BYDAY=` the
  routine's days, at the computed start time, lasting the routine, with a
  reminder at the start. **Floating local time** (`DTSTART:20261101T192500`,
  no TZID, no Z), chosen because iOS and macOS Calendar import a floating
  event as exactly that - 7:25 PM wherever the phone is, across a clock
  change and on a trip, which is what a bedtime is - and it needs no
  VTIMEZONE. A TZID would need a VTIMEZONE to be correct, and building one
  from Intl alone would mean guessing each zone's yearly rule. Text is
  escaped (`\ ; , newline`), control characters removed, lines folded at 75
  octets without splitting a character, CRLF throughout; a start before
  midnight moves to the evening before with its weekdays.

## Sync (signed in, free)

Filed under an **owner tag**, an HMAC of the account id under a key derived
from `IDENTITY_SESSION_SECRET` ("tada family owner v1") - never the id or the
email. With no secret, sync answers 503 and everything stays on the device.
Children's names are synced only when signed in, and never sent to a model.

- `families/<tag>` = `{owner, family, version, updatedAt}`: children, their
  routines and the family settings (the clocks plan). **Whole-document writes
  in a transaction with a version**: `PUT /api/family {family, base}` saves
  only if the account copy is still the version this device last saw;
  otherwise **409 with the account's copy**, and the page asks **"Use the
  account's" / "Keep this device's"** (names and routine counts of each);
  keep mine is a save against the version it was shown. A device that never
  synced cannot overwrite an account copy. 64 KB at most (413), 120 saves per
  account in 10 minutes.
- `progress/<tag>` = `{owner, steps: {<day>: {<child_routine_step>: ms}},
  fin: {<day>: {<child_routine>: ms}}}`. **Taps are not whole-document
  writes**: `POST /api/progress {today, taps}` merges **one key per (child,
  day, step)** (`store.mergeDeep`, Firestore's `set(..., {merge: true})`), so
  a phone and a tablet tapping at the same moment both stick (twenty at once
  tested, and in two real browsers). A tap is `+ms` done or `-ms` undone, and
  the later one wins on both sides. Days past **14** (taps) and **400**
  (stickers) are deleted in the same write (a plain read finds them; deleting
  twice is harmless). 60 taps a request, 600 requests per account in 10
  minutes, `today` within a day of the server's, no times from the future.
- The page queues every tap (signed in or not, capped, 14 days), flushes it
  when signed in, and pulls progress every 20 s while Today, Stickers or kid
  mode is on screen. On returning to the app it re-reads the family as well
  (adopted silently when this device has no unsaved change).
- **There is no query at all** - no index, no list.

## The model calls (metered, signed in only)

Both: `requireUser, requireBudget, requireDailyCap` **then** the route's own
8 KB parser (401 / 402 / 403 / 503 before it, never 413 - tested), then the
request rebuilt field by field (a 400 costs nothing), then one forced tool,
then the answer cleaned. **One door** (`await clientFor(req)` once, in
`metered()`) and **one call site** (`ai.ask`, the only `messages.create`).
Nothing is stored or logged. For a signed-out visitor, nothing, ever: the
sheets show what would be sent and offer a free account; 402 opens the credit
sheet; 403 `verify-email` shows its sentence and "Send the link again".

- **`POST /api/ai/routine`** (`propose_routine`): "6, school bus at 8:10, slow
  eater, needs reminders for shoes and bag" plus the kind, age band and
  done-by -> steps from the emoji set (an enum in the tool, cleaned again),
  1-30 minutes, at most 12 (`cleanProposal`: links, markup and bidi removed,
  an unknown emoji mapped from the name). Shown as a proposal; **Use this
  routine** opens it in the editor, nothing is saved without a tap.
- **`POST /api/ai/game`** (`game_ideas`): three playful ideas for one step,
  each 140 characters at most, no links (`cleanIdeas`); one can be kept on the
  step and is shown under it in kid mode for a grown-up to read out.
- **No child's name reaches the model.** The page replaces names with "my
  child" before sending (and shows exactly what is sent); the server does it
  again with `stripNames`, using the account's synced names first, then
  "named X", "my son X", a capitalised word starting a clause about a person
  ("Jake needs..."), capitalised words mid-sentence that are not ordinary
  ones, and every other occurrence of a name found; emails, phone numbers and
  links go too. The answer says how many were taken out. The prompts fence the
  parent's words as untrusted data and ask for "you", never a gendered word.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8141/tada/
npm test        # the rules first, then end to end over HTTP under a /tada mount
```

`TADA_MEMORY=1` and `TADA_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`)
- in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each
with `K_SERVICE` to prove it. `TADA_COLLECTION_PREFIX` (set to `tada_` by the
lab host) prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that does not
force a tool, keeps every request (`fakeClient.calls`), always proposes one
step with an emoji outside the set and 45 minutes (so the cleaning is
exercised), and reads triggers in the sentence or step: `BLANK`, `INJECT`,
`MAXTOKENS`, `UPSTREAMnnn`.

`test/run.js` (25 tests): templates in three ages (valid, from the set, no
gendered words), the emoji set, times and plurals, status lines and which
routine kid mode opens, read-aloud phrasing; the clocks helper with fixed
clocks and zones (New York back and forward, London forward, none, half an
hour, independent of the machine's zone) and both plans; the .ics (floating
DTSTART on the first matching day, RRULE, escaping, folding, CRLF, the
evening before); hostile cleaning (markup kept as text, bidi and zero-width
removed, every bound, no prototype pollution); progress (later undo wins,
merge both ways, the 14 / 400-day windows, refused taps); stickers and
streaks (misses, pending, the routine's own start); name stripping; both
briefs and answers; contrast in both themes and both kid skies; the page's
promises (relative URLs, no inline script, wrapped storage, the banner,
escaping, no link in kid mode, the hold, no gendered words, nothing after a
response); the local-only switches; and over HTTP: signed out with zero model
calls and 401s before every parser, the gate order, one door and one call
site, sync (409, keep mine, nothing identifying stored, the size cap, the
write limit), concurrent taps from two clients, both AI routes (no name
reaches the model, hostile output, errors not passed on, nothing stored), and
the 403 / 402 / 503 gates.

Rendered with Playwright at 390px and 1280px, light and dark (first run and
each setup step, the demo mid-step and its celebration, kid mode and "take
your time", the exit hint and grown-up question, the picker, Today with two
children, the clocks card, plan and plan on, the editor, emoji picker and
step menu, stickers, the print chart as Letter and A4 PDFs, both AI sheets
signed out and answered, side by side, a two-browser sync conflict) and a
hostile pass (markup, bidi, zero-width and 60-character names in a child, a
routine, steps and a kept game idea, plus an injected model answer, through
every view, sheet, kid mode and the print chart: nothing injected, no CSP
violation).

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Data

- **In the browser** (every access wrapped): `tada-family-v1` (children,
  routines, family settings), `tada-progress-v1` (taps and stickers),
  `tada-sync-v1` (the account version last seen, unsaved-change flag and the
  tap queue), `tada-prefs-v1` (this device's sounds, read-aloud and the child
  last looked at).
- **In the lab database**: `tada_families/<tag>` and `tada_progress/<tag>`
  (above). No sentence, step game or AI answer is ever stored by the server.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, the service
worker. Signed in, free: `GET|PUT|DELETE /api/family`, `GET|POST
/api/progress`. Metered: `POST /api/ai/routine`, `POST /api/ai/game`. The
shared account at `/api/auth`.

## Ideas not built yet

- **A second parent without sharing a password**: a family invite (the
  family is one account's today).
- **Per-child rewards** ("10 stickers = pick the Friday film") - kept out of
  v1 so the stickers stay a nudge, not a currency.
- **Photos as steps** for children who know their own things better than a
  drawing.
- **Server-sent reminders** - there is no sender; the calendar file and,
  in an iPhone app, local notifications cover it.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; handlers by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; every parser that takes a
  body runs after its gates.
- Every typed name, step and kept idea, every synced family and every model
  answer is untrusted: cleaned in the core, bounded, and escaped on render;
  the print chart and the .ics are escaped for their own formats.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
