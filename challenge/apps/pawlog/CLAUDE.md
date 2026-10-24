# For Claude: Pawlog

Fed? Walked? Meds given? The whole house knows. Pet care for a household
with more than one person in it: each pet's **routine** (from a template by
kind, every item with a time window and a repeat), a **Today board** where
one tap marks a job done with who and when ("Fed by Sam 7:42am"), the
**double-done guard** ("Already fed by Sam at 7:42 - do it again?", the same
for a medicine dose), overdue jobs that glow, **undo for two minutes**, one
**household link** everyone opens with no account, **sitter links** that close
on a chosen day, **medicines** with doses at set times and an end date,
**vaccinations, flea/worm treatment and vet visits** with due dates, a
**weight log** with a chart, **Due soon**, the **week** ("walked 13 of 14
times"), streaks and a gentle **who did what**, and every due date in your
**own calendar** (.ics). Optional AI **reads the vet paperwork** (a photo or
pasted text) into records you tick before they are added.

Built 2026-10-24 as an **everyday** drop: Firstday (2026-10-23) was a
business one, so today was the other kind. **Staging only**: no custom domain
until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/pawlog`,
served at `challenge.strongtechnicalconsulting.com/pawlog/`, data in
`pawlog_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (everyday life)

In a house with a pet and more than one person, "did anyone feed the dog?"
is asked every day. The dog gets fed twice or not at all, a dose of medicine
is missed when the person who usually gives it is away, and the booster due
date is on a card in a drawer. A group chat does not know what was done this
morning, and a whiteboard does not travel to the office or to the sitter.

**Who it's for:** households with pets, flatmates, pet sitters and dog
walkers.

**Not a repeat:** Sprout is houseplant care (a sitter sheet inside its link,
one owner); Chorus splits household chores in general. Nothing in the lab or
the portfolio tracks a pet's care across a household - the shared board, the
double-feeding guard, doses and due dates.

**Who pays.** Almost nobody. Pets, routines, the board, the guard, undo, the
household and sitter links, medicines, health records, weights, the week, the
calendar file and the sample are free, need no account and make no model
call. A **free** account keeps the owner's household on every phone. The one
metered thing is **"Read the vet paperwork"** (Haiku for the free tier,
Sonnet for members via `identity.planFor`), about a cent.

**How it becomes an iPhone app.** Local notifications when a window opens
and when it is about to be missed (no sender needed), a widget ("Biscuit:
dinner due 5:30"), an interactive notification to tick it from the lock
screen, EventKit instead of the .ics, the camera straight into "Read the vet
paperwork", and an App Clip from the household link so nobody installs
anything.

## The decisions that matter

- **One rules file, run three times.** `public/pawlog-core.js` is UMD
  (`window.PawlogCore` in the page, `require` in the server and tests):
  cleaning, time zones, repeats and templates, the board, the guard, undo,
  medicines, health, weights, the week, every change (`act`), what each link
  shows, the .ics and the sample. **No clock and no dice** (tested): "now"
  is handed in as milliseconds and fresh ids come from an `ids` function. A
  household only on the phone runs `act` in the page; a shared one posts the
  same change and the server runs `act` inside a transaction - one set of
  rules, so the sample cannot drift from the real thing.
- **The household's own zone.** A log is an instant; the board reads it in
  the household's IANA zone (`zoned`, by `Intl`), so "today", the window and
  "overdue" are the household's clock, not the server's or the viewer's.
  Days are civil (UTC-midnight sums). Tested across London's and New York's
  autumn changes (25-hour days), the spring one (23), Auckland's New Year,
  and byte-identical boards, weeks and .ics whatever the process zone is.
- **Repeats** (`dueOn`): every day; every N days (2-30) from an anchor;
  weekly on the anchor's weekday; monthly on the anchor's day of the month,
  **or the month's last day when it is shorter** (the 31st is Feb 28, Feb 29
  in a leap year, Apr 30). Nothing is due before its anchor.
- **Templates** (`TEMPLATES`): dog - breakfast, morning walk, evening walk,
  dinner; cat - two meals and the litter; rabbit, bird, fish (feed daily,
  water change weekly), reptile (feed every 3 days, monthly tank clean),
  other. Every item is editable.
- **The guard** (`alreadyDone`): a "done" for a job already done **today**,
  or within **30 minutes** of the last one (so the 11:55pm feed is still
  "just now" at 12:05am), is a 409 `code: 'already'` with who and when,
  unless the tap says `again: true` - the page asks "do it again?" first. A
  medicine dose says "given" and warns that a double dose can be dangerous.
  On the server it runs inside the transaction: **two phones tapping at
  once, one lands and the other hears who** (tested over HTTP).
- **Undo**: a tick can be taken back for **2 minutes** (the toast's Undo, or
  the guard sheet on your own tick), then a 409. A sitter can take back only
  their own.
- **Medicines** (`cleanMed`): name, dose, 1-4 times a day, a repeat, a start
  and an optional last day. Each dose is a board row (`<med>@<minute>`, a
  window an hour before to two after). A course past its last day drops off
  the board and reads "Finished Oct 26"; "Stop" ends it today; Due soon says
  "Course ends in 2 days".
- **Health** (`cleanHealth`): vaccination, flea & tick, worming, vet visit,
  other; given and/or due, repeating every N months. **"Done today"** sets
  given to today and the next due by `addMonths` (month-end clamped). Due
  soon is the next 30 days and anything overdue.
- **Weights** in grams, shown in lb or kg (a household setting), one per pet
  per day, 60 kept per pet; the chart is inline SVG.
- **The week** (`week`): the last seven days per pet; today counts only what
  is done or past its window. Lines per kind of job ("Walked 12 of 13
  times"). **Streak**: days in a row with everything done, ending yesterday
  (or today once today is complete); a day with nothing due neither counts
  nor breaks it. **Who did what** is a share bar in **alphabetical** order -
  no ranks, no medals - with "A share, not a scoreboard".
- **Contact details live in one field.** The vet's phone (`cleanPhone`, 7-15
  digits) is the only phone number Pawlog keeps, and the page marks that
  field "The one number". A pet's notes travel to the sitter, so anything
  shaped like a phone number, an email, a street address, a postcode/ZIP or
  an account/reference number is taken out of them (`stripPrivate`); the
  page refuses it first with a sentence.
- **The sample** (`sample(nowMs, tz)`): "The Hartley house" (made up) -
  Biscuit the dog and Miso the cat, Sam, Alex and Priya, the templates plus a
  weekly litter change, today four of nine done (breakfast fed by Alex at
  7:42am when that is past, else a little before now; Miso fed by Sam, so
  tapping it as Alex shows the guard), ear drops twice a day ending in 3
  days, a cat flu booster due in 9 days, flea, worming, rabies and a vet
  recheck, a weight trend, the vet (a 555-01xx fiction number) and six days
  of history with one missed evening walk. You are Alex. Tested at six
  instants including 3am, a clock change, a leap day and New Year's Eve in
  Auckland. Home's "Preview Jo's sitter link" draws the sitter's exact view
  of it.

## Shared homes and links (`lib/homes.js`)

Firstday's and Rota's anonymous-link pattern.

- `homes/<CODE>` - one document: the household, `link` (the household
  link's code), `sitters: {<CODE>: {name, until, expiresAt}}`,
  `ownerHash`, `creator`, `expiresAt`, `v`. Every change runs in
  `store.transact`. `?since=v` answers `{same: true}`, so the page's
  **20-second poll** (while visible, and on return) is one small read.
- `links/<CODE>` - `{home, role: 'member'|'sitter'}` and nothing else. The
  household link and each sitter link are their own opaque codes; none is
  the home's own code. **Replace** kills the old household link at once.
- **Codes** 10 characters from 32 unambiguous ones (~10^15) - links, never
  typed. Unknown, malformed, replaced, closed and expired read the same 404.
- **The owner** holds a 22-character key returned once on share, sent in
  `X-Pawlog-Key` (never in a URL the server sees), kept in this phone's
  `localStorage`; the home keeps `sha256(key + code)`. "Copy my owner link"
  puts it after `#` (`o/<CODE>#k=...`); the page stores it and strips it.
  Signed in, the account keeps the code and key instead.
- **Members** open `h/<CODE>`, pick their name or add one (`join`; the same
  name folded is the same person, 12 at most). A name is a first name and at
  most an initial (`firstName`). No device claim: a household trusts itself;
  the owner can take a name out and replace the link.
- **Sitters** open `s/<CODE>`. The owner names them and picks the last day
  (today to 60 days ahead); the link closes at midnight after it in the
  household's zone. Three open at most. A sitter may only `done` and `undo`
  their own tick (403 for everything else); their ticks read "Fed by Jo".
- **What each link reveals** (tested by exact keys): the household link -
  the household (`memberView`): name, zone, units, members' first names,
  pets, routine, medicines, health, weights, vet, the last 35 days of ticks,
  and its own code; never the home's code, a sitter code, a hash or the
  device tag. A sitter link (`sitterView`): the household's name, the pets
  (name, kind, notes), the routine, the medicines still running, today's and
  yesterday's ticks (theirs by name, everyone else's as "Fed 7:42am"), and
  the vet's practice and phone. **Never** the household's names, health
  records, weights, birthdays or any other link.
- **Limits** (`H.LIMITS`, per instance, in memory - they slow a script, they
  do not stop a determined one): 10 shared homes per address an hour (IPv6
  by its /64), 500 across the instance; **5 live homes per phone** (a
  `creator ==` query - the only query, a single equality filter, no index);
  30 **distinct** wrong codes per address in 15 minutes; 600 writes per
  address in 10 minutes; 30 new names per address an hour; 240 account
  saves per account in 10 minutes. In the core: 12 people, 12 pets, 80
  routine items, 24 medicines, 120 health records, 60 weights a pet, 35 days
  and 3,000 ticks of log.
- **Expiry**: a home 180 days after its last change; a sitter link at its
  day's end. Checked on every read and deleted by the read that finds it (no
  timer - billed per request).

## Signed in, free: the owner's household follows them

`accounts/<tag>` = `{home | shared: {code, key}, updatedAt}`, the tag an
HMAC of the account id under a key derived from `IDENTITY_SESSION_SECRET`
("pawlog account v1") - never the id or the email. While the household is
only on the phone the whole of it is kept (cleaned by `cleanHome`); once
shared, only its code and key. `PUT /api/mine` refuses a copy older than the
account's (`stale: true`), so a forgotten phone cannot undo a newer one; on
sign-in the newer of phone and account wins. The sample never goes. No
secret: 503, and it stays on the phone. A household joined through someone
else's link is not kept - it is theirs.

## "Read the vet paperwork" (the one model call)

`POST /api/read-paperwork {kind, photo | text, today}`: `requireUser,
requireBudget, requireDailyCap` **then** the route's own 9 MB parser (tested
401/402/403/503, never 413), then `ai.brief` (a 400 costs nothing): one
photo checked by its bytes (`lib/photo.js`: JPEG/PNG/WebP, 4 MB; the page
shrinks it to 1600px through a canvas, which also drops its EXIF) **or**
pasted text up to 8,000 characters with **anything shaped like an address,
an account or reference number, an email or a phone number taken out before
the model sees it** (`stripPrivate`). The model is told the pet's kind and
nothing else about the household - no names. One forced tool,
`record_paperwork` -> `{vaccinations: [{name, kind, given, due}], medicines:
[{name, dose, schedule, until}], weight, nextVisit}`. `ai.cleanProposal`
strips the same shapes (and prices) from every string the model sends back,
keeps kinds from the list, dates real and in sane ranges, 12 vaccinations
and 8 medicines at most, no duplicates, a weight only 10 g-150 kg; nothing
usable is a 422. It returns a **proposal**: the sheet lists it with ticks,
and only "Add the ticked ones" sends ordinary changes (a schedule in words
becomes times by `parseSchedule`). The photo and the text are never stored
or logged (tested). Signed out, the sheet explains it needs a free account
and that everything else stays free; 402 opens the credit sheet; 403
`verify-email` shows its sentence.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `h/:code`,
`s/:code`, `o/:code`. No account: `POST /api/homes` (share), `GET
/api/homes/:code[?since=v]`, `POST /api/homes/:code/act` (core changes plus
`relink`, `sitter`, `unsitter`), `DELETE /api/homes/:code` (owner key);
`GET /api/l/:code[?since=v]`, `POST /api/l/:code/act` (household or sitter
link). Signed in, free: `GET|PUT|DELETE /api/mine`. Metered: `POST
/api/read-paperwork`. The .ics is built in the page from the same core.

## On the phone

`localStorage` (every access wrapped): `pawlog-home-v1` (this phone's own
household, the sample, or the shared one's code, key and last copy),
`pawlog-me-v1` (who this phone is, per household), `pawlog-joined-v1` (the
last household link opened, so the bare address opens it again),
`pawlog-tab-v1`. The board redraws every 30 s so "Due now" and the glow
follow the clock with no server. Views: Today, Health, Week, Home (bottom tab
bar on a phone, a left rail on a desktop via `desktop.css`); a sitter link is
one page with no tabs. The service worker (`sw.js`, network first) never
caches `api/` or a link page.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8136/pawlog/
npm test        # pure rules first, then end to end over HTTP under a /pawlog mount
```

`PAWLOG_MEMORY=1` and `PAWLOG_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`.
`PAWLOG_COLLECTION_PREFIX` (set to `pawlog_` by the lab host) prefixes every
top-level collection. The fake model refuses a call that does not force a
tool, keeps what it was sent (`fakeClient.seen`, images as a size only), and
reads triggers in the text: `BLANK`, `INJECT`, `MAXTOKENS`, `UPSTREAMnnn`.
For `npm run dev` with a signed-in paperwork read, also set
`REQUIRE_VERIFIED_FOR_FREE_AI=0`.

`test/run.js` (23 tests): cleaning, first names and contact stripping;
repeats across month ends and leap years, templates; zones and both clock
changes; the board, the guard (same day and across midnight), undo; medicine
courses starting, ending and stopping, the double-dose guard; health due
dates and "Done today"; weights; the week, streaks and the share; the sample
at six instants; what each link shows by exact keys and what a sitter may
do; the .ics; contrast in both themes and the lab card colours; the
local-only switches; the prefix and the one query; the page (no inline
script, relative URLs, wrapped storage, no email, no clock in the core,
`esc()` on drawn fields, nothing after a response); and over HTTP: signed
out with zero model calls, the gate order, a shared home's life (join,
ticks, poll, relink, delete, one 404 for everything), two taps at once,
undo's window, sitter links (slice, ticks only, cap, close, expiry), limits
and hostile names, sync, the paperwork read end to end (what the model
sees, hostile output, photo bytes, nothing stored) and the
401/402/403/503 gates. The shared files (`lib/identity.js`,
`identity-store.js`, `byok.js`, `stripe.js`, `webauthn.js`;
`public/desktop.css`, `passkey-client.js`, `verify-banner.js`) are synced
copies - edit them in `eriks-projects/shared/`.

## What is deliberately not built

- **Reminders from a server.** There is no sender; the board glows, the
  calendar file reminds, and an iPhone app would use local notifications.
- **Binding a name to a phone.** Anyone with the household link can tick as
  anyone in it. A household trusts itself; the owner can replace the link.
  Rota's device claim is the shape to copy if that ever matters.
- **Several households on one phone.** One own household, plus whichever
  household or sitter link is open. A dog walker with five clients uses
  their five sitter links.
- **Storing the paperwork.** It is read once; only what you tick becomes
  records. No documents, no photos.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`, handlers by one
  `data-act` listener and `addEventListener`; every drawn field through
  `esc()`. Checked in Chromium with hostile pet, person and household names
  through the board, the household link and the sitter link: no CSP
  violation, no injected element.
- No model call for a signed-out visitor, ever; the metered route's gates
  run before its parser, and the account parser after sign-in.
- `h/*`, `s/*`, `o/*`, `/api/homes*` and `/api/l*` answer `no-referrer` and
  `noindex`: a code is a key to someone's home routine. Only the app's own
  errors reach the page in their words; a provider error is a 502 (503 "The
  AI is busy"). Nothing logged carries a name, a note, a record or a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
