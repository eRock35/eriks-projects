# For Claude: Baste

One oven, nine dishes, dinner at four - the whole day worked backward, on
every phone in the kitchen.

Built 2026-11-26 as drop #72: **the Thanksgiving holiday drop** (see
"Holiday drops" in `challenge/CLAUDE.md`; the table's seed was "oven & dish
timeline"). An **everyday** app by kind - a household job - so the next
regular drop is a business one. It is for Christmas, Easter and any big
dinner as much as for today: nothing in it is tied to the date.

## Why it exists

The big holiday dinner is a scheduling problem. One oven, dishes at
different temperatures and times, the turkey has to rest, the rolls go in
last, the pie should have been made this morning - and the cook is doing the
arithmetic on the back of an envelope while three helpers ask "what can I
do?".

## What it does

- **A dinner in a minute, no sign-in** (`#new`): a first name, the day and
  time you eat, the kitchen's time zone, one to three ovens and how many
  dishes fit in one at once (a turkey or ham takes a whole oven), °F or °C,
  and the dishes - tapped from a built-in list of seventeen
  (`BasteCore.PRESETS`), a turkey by weight and stuffed or not, or your own
  (prep, cook, oven temperature or stovetop or no cooking, rest, can be made
  ahead).
- **The plan** (Plan tab): every step in one timeline, worked backward from
  dinner; the oven's use as a strip and a list; conflicts on top, each with
  fixes to tap.
- **Today** (the first tab): the dinner clock and its countdown, **Now**
  (steps that are due, big, with Done / Late +10 / +20 / "I'll do it"),
  **Cooking** (what is in, when it comes out, a countdown) and **Next**.
- **Helpers**: one link or six-character code; everyone sees the same live
  timeline, claims a dish ("I've got it") or one step, ticks things done,
  and a guest adds what they are bringing ("20 minutes at 350 when I
  arrive at three") so the plan counts it.
- **Fill a dish in from a recipe** (signed in, metered - the one model
  call): paste a recipe or add a photo; it comes back as a draft in the dish
  form, which the cook checks before saving.
- **See a made-up Thanksgiving** (`#try`): nine dishes at 1:10 PM, drawn by
  the same code and changed by the same rules, in memory only.

**Where it lives:** `challenge/apps/baste`, served at
`challenge.strongtechnicalconsulting.com/baste/`, data in `baste_*`
collections of the lab's `challenge` database. See `challenge/CLAUDE.md`.
Every browser URL is relative to `BASE`; keep it that way.

## The plan: `BasteCore.plan(view, now)`

Never stored and never a model's: worked out from the dishes on every draw,
the same on every phone and on the server. Three passes.

1. **Backward (the plan on paper).** Each dish is ready at dinner, so it
   comes out its rest before, goes in its cooking time before that, and its
   prep starts before that. An empty oven is switched on 15 minutes before
   (an oven emptied under 45 minutes ago is still on). A turkey is basted
   every 45 minutes, never in its last 20. **Made-ahead** dishes are stacked
   before the day's cooking starts (oven ones one after another) and are
   **off the oven plan**; a "warm it" step before dinner says microwave,
   stovetop, or the oven if there is room - the plan does not book the oven
   for reheating, and says so.
2. **The ovens.** Each oven dish goes in the oven where it clashes with the
   fewest others (the big and the long first). Two dishes overlap and
   clash when their temperatures are **10°F or more apart** (closer is one
   setting on any dial - which also keeps a Celsius dinner's 175 equal to
   350°F), when one of them takes the whole oven, or when more are in at
   once than fit. What is left is a **conflict**, with its window.
3. **Forward (the day).** From what is ticked, each dish's "late", a
   guest's arrival and the clock: a dish comes out its cooking time after
   it **actually** went in; a dish cannot go in before the dish ahead of it
   in the same oven (one it cannot share with) is out; and **no undone step
   is ever in the past** (after two minutes' grace). If any dish would be
   ready after dinner, **dinner moves** - by that much, **rounded up to five**
   minutes - and everything not yet started moves with it; a dish
   already cooking keeps its time and waits. The plan carries `moved` and
   `why` ("Turkey needs 4 h 45 min from now."), the page shows it as a
   banner on every tab, and the host may accept the new time. It moves
   **never silently**: this is the "dinner is in three hours and the turkey needs
   four" case, and the answer is "Dinner moves to 5:45 PM".

### Conflicts and fixes (`fixesFor`)

A fix is a suggestion the cook taps; it is saved on the dish as `fix`
(`{early, temp, stove}`) or as `ahead`, shown on the dish as "Adjusted",
and undone from there. At most four per conflict, most useful first.

- **Use the roast's rest / cook one first** (`early`): the first dish comes
  out so many minutes sooner and waits covered while the second cooks -
  only up to the dish's `hold` (a turkey 60 minutes beyond its rest, a ham
  45, most sides 30, rolls 10). If the wait would be longer, the fix is not
  offered: nothing is invented.
- **Share the oven** (`temp`): within **25°F** (about 15°C), the dish that
  cooks for less moves to the other's temperature and its time is scaled in
  proportion (`adjust`) - **always marked an estimate** ("check it early")
  in the fix, on the step and on the dish. Not for a dish that takes the
  whole oven, and not offered beside "cook one first".
- **Make ahead and reheat**: only a dish marked "can be made ahead".
- **Move to the stovetop**: only built-in dishes with a stovetop version
  (`stoveCook`).
- A dish already in the oven is not offered a fix that would move it.
- With no fix that fits, the card says so and points at editing a dish or
  adding an oven.

### Running late

`late` is minutes on a dish, added by taps (two phones tapping +10 make
+20), bounded at four hours. It moves that dish's undone steps; what waits
for its oven; and dinner, if the dish's slack (minutes it was coming out
early) does not absorb it. Ticking a dish **in** sets its `late` back to 0 -
its real start now says it all - and "late" after that means "longer in the
oven". "Did it on time" ticks a step at its planned time (never later than
now), for the cook who forgot to tap.

## Time zones and the clock

Dinner is typed as a **wall-clock time and the kitchen's IANA zone**;
`zonedToUtc` makes it one instant (`eatAt`) **on the server** - a phone
never sends one. Every step is an instant; every phone shows them in the
dinner's zone (and says "not where this phone is" when it is elsewhere).
The zone rules are the platform's (`Intl`), never a table here. A plan
worked back across the night the clocks change keeps every real minute
(tested: a 12-hour roast before a spring-forward lunch starts at 1:00 AM).
A guest's arrival is a wall-clock time on the dinner's day in its zone.
The rules read no clock: `now` is handed in.

## Food safety (keep the wording conventional)

Times are estimates for planning. The page says, on every tab that shows a
plan and on the start form: "Use a thermometer: poultry and stuffing are
done at 165°F / 74°C (USDA)." The turkey's "out" step and its form carry the
longer line (thickest part of the breast, innermost thigh, the centre of
the stuffing if stuffed). The turkey chart is USDA's 325°F roasting table
for a thawed bird, 8 to 24 lb, read along each range (`turkeyMinutes`);
outside it the app refuses and asks for a dish with the cook's own times.
Ham: reheated to 140°F / 60°C if fully cooked, 145°F / 63°C and a
three-minute rest if fresh. Do not add advice beyond these, do not shorten
a time, and never let the model write a safety claim (its tool has no
free-text field but the dish's name).

## The dinner (no account) - Pencil's table pattern, as Arrivals uses it

- **Members are browsers.** An HttpOnly cookie `baste_k` (22 random
  characters, `Path` = the app's base, SameSite=Lax); the dinner keeps only
  `sha256("baste member v1:" + key + ":" + dinner id)`.
- **One versioned document**; every change moves `v`. Phones poll every 5
  seconds **while the page is visible and a dinner is on screen**;
  `?since=v` answers `{same: true}`.
- **One door for every change**: `POST /api/d/:id/act {action}` ->
  `Core.act(doc, mid, action, {now, id, today})` inside a transaction,
  which returns exactly the keys to set or delete (`dishes.<id>`,
  `dishes.<id>.late`, `.who`, `.fix`, `.ahead`, `done.<step key>`,
  `claims.<step key>`). Step keys are `<dish id>_<heat|prep|in|out|make|
  warm|baste_N>`; a tick is refused unless the plan has that step. Twelve
  phones adding dishes while others tick, claim and tap "late" all land
  (tested). The example on the page runs the same function.
- **Anyone in the dinner** adds, edits or removes a dish, claims, ticks,
  says "late" and applies a fix - the point is that helpers help. **The
  host** alone changes the time, zone, ovens or unit, removes a member, or
  deletes the dinner. What a departed or removed helper had is open again;
  their dishes stay.
- **Before joining**, a code shows the dinner's name, when it is, who
  started it and how many are in - no dish.
- **The same 404, word for word**, for an unknown id, a malformed one, one
  that expired and one that is not yours.
- **Expiry on read: 7 days** after the dinner's day (`Core.expired`), by id
  or by code. No timer; the host can delete it at once.

### Privacy

No phone number and no email address is collected from anyone at a dinner,
held in code: every text field passes `Core.refuse` (an @ of any width, a
link, seven digits in a row in any script, markup - refused with a reason).
Names are first names. The store holds dinners and the accounts' lists and
nothing else (tested: no browser key, no account id, no email, no recipe).

### Limits (per instance, in memory: they slow a script, not a determined one)

20 people and 30 dishes a dinner (refused, never cut); 10 new dinners and 40
new members per address an hour; 30 distinct wrong codes or ids per address
in 15 minutes; 900 writes per address and 150 per member in 10 minutes;
bodies 16 KB (the metered route 9 MB, after its gates).

## Signed in (free): the other phone

`POST /api/d/:id/keep` writes `members.<mid>.owner` = an HMAC of the account
id AND the dinner id ("baste seat v1") and adds the dinner to `mine/<tag>`
(`{g: {<id>: {title, eatLocal, at}}}`, the tag an HMAC of the account id,
"baste owner v1"; 30 kept). Never the account id or the email in Baste's
own store.

## The AI: one call, behind the usual gates (Arrivals' pattern)

`POST /api/read`: `identity.requireUser`, `requireBudget`, `requireDailyCap`
-> the 9 MB parser -> `ai.brief` (a 400 here costs nothing: text OR one
image, sniffed by its bytes) -> the lab's guard
(`global.LAB_AI_GUARD.allow({provider: 'claude', req, app: 'baste'})`; a no
is its message plus "Typing the dish in still works.") -> ONE
`messages.create` with the forced tool `record_dish` -> the guard's `record`
with `priceUsd` in a `finally` (not for a member's own key). Free tier
Haiku, members Sonnet, by `identity.planFor`. Claude only.

- **A draft, never a save**: `{name, method, prep, cook, temp (°F whatever
  the recipe printed), rest, canAhead}` goes into the dish form under
  "Filled in from your recipe. Check every field".
- **Nothing of the recipe is kept or logged.** The tool has no notes field;
  only known fields are read; `Core.cleanDraft` bounds every number and
  blanks a name with an @, a link, digits or markup (no name -> 422).
- A provider's own words never reach the page (502, or 503 when busy).
- The stand-in (`BASTE_FAKE_AI`) reads "Prep: 25 minutes / Bake at 375 F
  for 45 minutes / rest 10 minutes / make ahead"; triggers BLANK, INJECT,
  MAXTOKENS, UPSTREAMnnn.
- **Nothing else uses a model**: the schedule, the conflicts and the fixes
  are rules, so they are free, instant and the same on every phone.

## Offline

`public/sw.js` (network first, this app's own files only, never `api/`)
plus the last copy of the dinner in `baste-last-v1`: once loaded, the page
opens with no signal and the timeline and its countdowns keep running from
that copy. **Ticking, claiming and seeing others' changes need the
network** - the ribbon says so, and a failed change says "You look
offline". Changes are not queued for later.

## The look

The lab's house style (the HOA Desk rules; `public/app.css` opens with
them): a pure white page (true black in the dark theme), hairlines, system
fonts, one accent - a sage green, `#476800` where it carries text on white
(`#b7da6c` in the dark theme), the lab card's `#5c8200` as the brand dot.
Status colours only beside a word. On phones a floating pill (Today, Plan,
Dishes, Helpers; a badge counts conflicts); from 900px the same four in the
header. Sheets are bottom sheets on phones and dialogs from 900px. Motion
only inside `prefers-reduced-motion: no-preference`. No style attribute
anywhere: a person's colour is a class, the oven strip an SVG drawn with
attributes. Countdowns tick every second by `textContent`; the page is
drawn again every 15 seconds while a dinner is on screen and no sheet is
open.

## On the phone

`baste-list-v1`, `baste-prefs-v1`, `baste-last-v1` in localStorage through
`public/baste-store.js` only; every access wrapped, memory as the fallback.

## The decisions that matter

- **One rules file, run three times.** `public/baste-core.js` is UMD. No
  clock and no dice (tested).
- **The instant is the server's.**
- **No stored plan**: steps, conflicts, fixes and "moved" are worked out
  from the dishes, the ticks and the clock on every draw.
- Queries are single-field equality (`code ==`): no composite index.

## Local run and tests

```
npm run dev     # memory store + stand-in model, at http://localhost:8184/baste/
npm test        # the rules first, then end to end over HTTP under a /baste mount
```

`BASTE_MEMORY=1` and `BASTE_FAKE_AI=1` both **throw on Cloud Run**.
`npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0` like every lab app.
`test/run.js` (35 tests): time zones and the clocks changing; a dinner's
details; the turkey chart; Fahrenheit and Celsius; a dish; the backward
plan; oven conflicts; every fix; the day running forward; running late and
what it pushes; dinner must move; the one door; what a phone is shown and
the 7-day expiry; the example; text; storage; contrast and the lab card;
the page's promises; the copy; the local switches; and over HTTP: signed
out, cross-site writes, starting and joining, the plan, phones at once,
leaving and removing, the same 404 and expiry, the limiters, hostile input,
the account on a second phone, the recipe read, what the model sends back,
the gates and the guard, and what the store holds.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/passkey-client.js`, `verify-banner.js`)
are synced copies - edit them in `eriks-projects/shared/`.

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, `/sw.js`, the page. No
account: `POST /api/dinners`, `GET|POST /api/join/:code`, `GET /api/d/:id`
(`?since=v`), `POST /api/d/:id/act`, `DELETE /api/d/:id/members/:mid`,
`DELETE /api/d/:id/me`, `DELETE /api/d/:id`. Signed in: `GET /api/mine`,
`POST /api/d/:id/keep`, `DELETE /api/mine/:id`. Signed in and metered:
`POST /api/read`. The shared account at `/api/auth`.

## What is deliberately not built

- Shopping lists, recipes' steps, scaling (Ladle does recipes), leftovers,
  who-brings-what beyond a guest's own dish.
- Push or sound alarms (the lab has no push); thawing schedules; carving.
- Booking the oven for reheating; pinning a dish to a chosen oven; a queue
  of offline changes; a second model call.

## Security

A script CSP on every page; no inline `<script>`, `on*=` or `style=`;
clicks by one `data-act` listener. Every non-GET `/api/*` outside the
shared account refuses another site's request (403) and a body that is not
JSON (415). Every name is untrusted: cleaned in the core, escaped on
render. `Referrer-Policy: no-referrer` and `noindex` on the dinner APIs;
codes travel in fragments only. Only the app's own errors reach the page in
their words.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
