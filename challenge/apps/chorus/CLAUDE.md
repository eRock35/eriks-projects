# For Claude: Chorus

Chores split fairly - and everyone can see it. For roommates, couples and
families. Chorus **deals the week's chores** by how big each job is (effort
1-5 points), how much each person takes on (a kid counts half), what each
person can't or won't do, and who had the least-liked jobs lately - then
everyone **ticks** their own on one shared board, **swaps** what they can't
get to, **nudges** through their own share sheet, and the **Fairness** tab
shows, in one plain line, who is carrying the house ("Maria did 38% of the
work in the last four weeks - a fair share is 31%").

Built 2026-10-04 as an **everyday** drop: Shadow (2026-10-03) was a business
one, so today was the other kind. A free pick from ordinary life - not from
the inbox, not a holiday. **Staging only**: no custom domain until Erik
decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/chorus`,
served at `challenge.strongtechnicalconsulting.com/chorus/`, data in
`chorus_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Who does what at home is one of the most common sources of friction between
people who live together. The usual fix - a chore wheel on the fridge - is
unfair in ways nobody can see: the same person keeps landing the bathroom, a
"wipe the counter" counts the same as "clean the oven", a nine-year-old gets
the same share as a parent, and nobody can tell who is quietly carrying the
house until someone snaps. Chorus makes each of those visible and fair:
effort is weighed, capacity is weighed, the worst jobs rotate, and the
numbers are on everyone's phone.

**Who it is for:** roommates (three starter templates: Roommates, Couple,
Family with kids), couples who are tired of keeping score in their heads,
and families who want kids pitching in at a kid's share.

**Who pays.** Almost nobody. The example home, a household on one phone,
putting it online, joining, ticking, swapping, nudging and fairness are free
and make no model call. Only the host of an online household needs a
**free** account (so it is theirs to run and delete); everyone else joins
with a code and **no account**. The one metered thing is **Suggest chores**
from a photo or a description (Haiku free, Sonnet for members via
`identity.planFor`), about a cent, paid by whoever asks.

## The decisions that matter

- **One rules file, run three times.** `public/chorus-core.js` is UMD
  (`window.ChorusCore` in the page, `require` in the server and tests): the
  slots, the deal, ticks, swaps, the explanations, fairness, streaks,
  cleaning, templates. The server checks and stores; the page draws and runs
  the household on this phone and the example with the very same functions;
  the tests check one file.
- **Slots.** Each chore due this week becomes slots: daily is seven (one a
  day), "2-3x a week" alternates three (Mon/Wed/Fri) and two (Tue/Sat) by
  week, weekly is one, every 2 weeks and monthly (every 4 weeks) fall due
  counted from the week the chore was added (`start`). A slot is worth its
  effort. Slot ids are `<choreId>_<n>` - no dots, so they are safe as
  Firestore field paths.
- **The deal** (`deal`, pure and deterministic). Target: each person's load
  per unit of weight equals the household's (total points / sum of
  weights). Greedy first - the most constrained slots (fewest people able),
  then the biggest, then a stable order - then a bounded hill-climb of moves
  and pairwise swaps on one objective: the squared distance of each person's
  load-per-weight from the target, plus penalties. **Rotation:** someone who
  had a chore in the last four weeks pays `1.5 x effort x recency` to get it
  again (recency decays 1, .6, .35, .2 and is shared - three of a daily
  chore's seven slots count 3/7); a least-liked chore costs double that, plus
  a small nudge even with no history; holding many slots of the same daily
  chore in one week costs a little, so dishes spread across days. **Can't or
  won't do** is a hard rule: nobody is ever dealt one; one able person gets
  it; nobody able leaves it unassigned with a sentence saying so. Ties break
  by a finalised FNV hash of week + slot + person: deterministic, and
  different week to week. Same people, chores and history -> the same plan on
  every phone. Names and emoji are not part of it (`basisOf`).
- **A week is dealt once and kept** (`weeks/<homeId>_<Monday>`): it is the
  history the next week's rotation reads. A change to people or chores
  re-deals it (`ensureWeek`, when `basis` moved) **keeping what is done or
  swapped where it is** (`pinsOf`). Weeks are Mondays in the household's IANA
  time zone (`tz`, from the creator's phone).
- **A short first week.** A household started mid-week only gets slots from
  its start day on (`since`), and none of the "this week" chores when it
  started on a Friday or later - nobody should open a new app to a week of
  chores due by Sunday. The board says so and shows **Next week, at a
  glance**, a preview dealt by the same rules.
- **Explained in words** (`explain`, per chore and person): "Sofia's turn
  this week - Maria had it the last two weeks", "Only Ana and Sam can do this
  one - the others have it on their can't-do list", "Maria took two of these
  from Luis - the points moved with them". The interesting ones show under
  the chore; all of them in "Why the week looks like this".
- **Ticks credit the holder**, not the tapper: a parent can tick a kid's
  chore. A tick stores `{who, by, pts, at}`, so deleting a chore later does
  not rewrite history. Undo is a tap on the same button.
- **Swaps.** Online: the holder offers a slot ("Up for grabs" on everyone's
  board), anyone else who can do it claims it - one taker - and the points
  move with it; the offerer can take it back while it is open. On a phone the
  household shares: "hand it to" someone directly. A done slot can't be
  swapped.
- **Nudge** opens the phone's share sheet (or copies) with a friendly line
  ("Hey Sam - the bins go out tonight 🗑️ Thank you!"); starter chores carry
  their own phrasing. **Chorus never sends anything itself.**
- **Fairness** (`fairness`, computed on read): this week done vs had per
  person, the last four weeks' share of done points against each person's
  fair share (weight / sum of weights) with a marker, a week-by-week stacked
  bar, and streaks (weeks in a row with everything ticked; this week counts
  once it is all done and never breaks it while it is still going). The line
  names whoever is furthest over their fair share, or says it is nicely
  shared when everyone is within 5%.

### Two phones, one household (trip-planner's packing lesson)

A household is one document (`homes/<id>`) and each week one more. The busy
writes - a tick, an undo, a swap offered, claimed or taken back - go through
`store.transactKeys`: read the week inside a transaction, decide with the
core, then write **one key** (`ticks.<slot>` or `swaps.<slot>`) with
Firestore's `update()` - never the whole document. So two phones ticking
two chores at once can never write back a copy missing the other's tick, and
a swap offered to two people has one taker (the transaction re-reads it).
`test/run.js` ticks 18 chores from six phones at once and checks every one
stuck, shows the same two writes without the transaction losing one, and
claims one offer from two phones at once (200 + 409). Settings - people,
chores, the name - are whole-document transactions (rare, and still safe).
Each write bumps the household's `v`; phones poll `?since=v&week=<Monday>`
every 5 s while visible (one read when nothing moved; a new week is never
"same") and refresh when the app comes back to the foreground.

### Where a household lives

- **The example** ("The Garcias": Maria, Luis, Sofia who counts three
  quarters, Mateo who counts half and can't do the bathroom, groceries or
  laundry; ten chores; four weeks of history and this one in progress) is
  **dealt by the real rules** in `public/sample.js`, week after week, so its
  rotation, explanations and fairness are the app's own. Who did what is a
  hash: Luis lets some slide, Maria picks most of them up, and one of his is
  always up for grabs. Ticks and swaps work on the phone and are never saved;
  editing people or chores opens "Make it yours".
- **On this phone** (`localStorage` `chorus-home-v1`, every access wrapped):
  the fridge-chart phone, no account, no server. The page deals and stores
  its weeks itself.
- **Online** (`h/<id>`): from People, **Put it online** (sign in free) sends
  the household and its past weeks (`cleanWeeks`: only this household's
  people and chores, only real past Mondays, at most nine) to
  `POST /api/homes`, clears the phone's copy and lands on the invite card -
  code, QR (full screen on tap), Share link. A friend opening `j/<code>` sees
  the household's name and size and the **open seats** (people the host
  typed who have not joined) - "Which one is you?" - or joins as someone new
  with a name and an emoji.

## Who may do what (online)

- **Members** are this browser (an HttpOnly cookie `chorus_k`, path-scoped,
  22 random characters, stored only as `sha256(key + homeId)`) or a
  signed-in account that holds the seat (`acct`, an HMAC of the account id
  under a key derived from `IDENTITY_SESSION_SECRET`, "chorus account v1").
  The household holds no account id and no email.
- Anyone in the household ticks or unticks any chore (credit goes to the
  holder), offers their own and claims others', adds, edits and removes
  chores (everyone's house; every change shows on every board), and sets
  their own name, emoji, can't-do list and up to three least-liked chores.
  **The share (weight) is the host's** to set - a kid can't make themselves
  "a little" for the week. The host also adds seats, removes people,
  renames, rotates the code (old link and QR die) and deletes the household.
  A member can leave; the host can't (delete instead).
- **A stranger gets the same 404 a missing household gets** on every route,
  signed in or not.
- **Limits** (`lib/homes.js` LIMITS, per instance, in memory, like Flight):
  12 people, 60 chores, 3 least-liked, 5 households per host; 30 new members
  per address an hour; 30 **distinct** wrong codes or ids per address in 15
  minutes, then even the right code waits; 600 writes per address in 10
  minutes. IPv6 counts by its /64. Codes are 6 characters from 32
  unambiguous ones. A household nobody has touched in 180 days is deleted by
  the read that finds it (no timer - billed per request).

## Suggest chores (the one model call)

`POST /api/suggest` `{photo?: {type, data}, text?, have?: [names]}`:
`requireUser, requireBudget, requireDailyCap` **then** a 6 MB parser (a
stranger's body is never read; tested 401/402/403, never 413), then the
input checks (a photo by its magic bytes, 4 MB; or at least a few words of
description) before anything is spent, then one forced tool
`propose_chores` -> `{relevant, chores: [{name, emoji, effort, freq}]}`.
`ai.cleanSuggestions` puts every chore through the same `cleanChore` a typed
one gets (40 characters, markup/bidi stripped, one emoji or a broom, effort
1-5, frequency from the list), folds repeats, drops what the household
already has, keeps 20 at most. The page shows them ticked; nothing is added
until **Add the ticked chores**. The photo is shrunk to ~1600px on the
phone, read once, never stored or logged. Signed out, the sheet explains it
and offers a free account or the starter chores; 402 opens the credit
sheet; 403 `verify-email` shows its sentence and "Send the link again".

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8119/chorus/
npm test        # pure rules first, then end to end over HTTP under a /chorus mount
```

`CHORUS_MEMORY=1` and `CHORUS_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `CHORUS_COLLECTION_PREFIX`
(set to `chorus_` by the lab host) prefixes every top-level collection.
`npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model
refuses a call that does not force a tool. Triggers in the photo's bytes or
the description: `BLANK`, `INJECT`, `MAXTOKENS`, `UPSTREAMnnn`; anything
else is a kitchen (six chores, one of them "Dishes").

`public/qr.js` is Flight's vendored copy of Kazuhiko Arase's MIT "QRCode for
JavaScript", only its global renamed to `ChorusQR`. The shared files
(`lib/identity.js`, `identity-store.js`, `byok.js`, `stripe.js`,
`webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`.

## Data (Firestore: `chorus_*` in the lab database `challenge`)

- `homes/<id>` (16 random base64url characters) - `{name, code, tz, since,
  ownerTag, acctTags, createdAt, updatedAt, v, members: [{id, name, emoji,
  weight, cant, dislikes, host, keyHash, acct, joinedAt}], chores: [{id,
  name, emoji, effort, freq, start, nudge?}]}`.
- `weeks/<homeId>_<YYYY-MM-DD>` - `{homeId, week, basis, createdAt,
  assign: {slot: memberId|null}, ticks: {slot: {who, by, pts, at}},
  swaps: {slot: {from, to?, state: offered|claimed, at}}}`.

Nothing else: no email, no account id, no browser key, no photo (tested).
Queries are single-field equality (`homeId ==`, `code ==`, `ownerTag ==`,
`acctTags array-contains`), so **no composite index**. Households this
phone joined are remembered in `localStorage` `chorus-homes-v1`; the last
one opened in `chorus-last-v1`, so the home-screen icon opens it.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `h/:id`,
`j/:code`. Joining (no account): `GET|POST /api/join/:code` (`{seat}` or
`{name, emoji}`). Members: `GET /api/homes/:hid[?since=v&week=]`, `PATCH
/api/homes/:hid/members/:mid`, `POST /api/homes/:hid/members` (host),
`DELETE /api/homes/:hid/members/:mid` (leave; the host: remove), `POST
/api/homes/:hid/chores` (`{chores: [...]}` or one), `PATCH|DELETE
/api/homes/:hid/chores/:cid`, `PUT|DELETE /api/homes/:hid/ticks/:slot`,
`POST /api/homes/:hid/swaps/:slot` `{action: offer|cancel|claim}`. Signed
in (free): `GET|POST /api/homes`, `PATCH|DELETE /api/homes/:hid`, `POST
/api/homes/:hid/code`. Metered: `POST /api/suggest`.

## What is deliberately not built

- **Reminders and push.** There is no sender on this platform, and a chore
  app that pings is a chore app people mute. The nudge is a person sending a
  friendly line from their own phone.
- **Money, allowances or rewards for kids.** Points measure effort for
  fairness; turning them into pocket money is a different (and touchier)
  product.
- **Photos of finished chores** ("proof"). It would make the app a
  surveillance tool between people who live together.
- **Per-day time slots or a calendar view.** Daily chores carry a day; the
  rest are "this week". Calendar export would fit later.
- **"Keep my seat" for members** (Flight has it). Someone who joins while
  signed in is recognised by account on any device (the join stores the
  HMAC tag); someone who joined signed out is this browser only, and a new
  phone means the host removes the old seat and they join again. Worth the
  button if households use it across devices.
- **An App Clip / widget** with today's chores - the obvious iPhone shape.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`,
  handlers by one `data-act` listener (tested here and by
  `challenge/test/lab.js`).
- No model call for a signed-out visitor or a member without an account;
  the suggest route's gates run before its 6 MB parser, and going online's
  256 KB parser runs after its sign-in.
- Model output and every typed string are untrusted: cleaned, bounded,
  stripped of markup, control and bidi characters, and escaped on render.
- `h/*`, `j/*`, `/api/homes/*` and `/api/join/*` answer with `no-referrer`
  and `noindex`; a code and a household id are keys.
- Failures (`fail()`/`failure()`, Receipt's): only the app's own errors reach
  the page in their words; a provider error is a 502 (503 "The AI is busy").
  Nothing logged carries a name, a chore or a photo.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
