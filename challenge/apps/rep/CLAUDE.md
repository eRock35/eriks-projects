# For Claude: Rep

Lift, log, beat last time. A strength-training log for anyone lifting at a
gym or at home, beginner to intermediate: a **library of 43 exercises** (by
muscle group, tagged barbell / dumbbell / machine or cable / bodyweight) plus
custom ones, **a workout screen built for one thumb** (last time's sets greyed
beside every set, big steppers, "same as last set" in one tap, an optional
RPE), a **rest timer** that starts by itself and survives a locked screen, a
**plate calculator** (exact, or the nearest weight below and above), a
**"beat last time" suggestion** per lift (add weight, stay, or deload after a
third miss), **PRs as they happen** (weight, reps at a weight, e1RM, volume),
**progress** (an e1RM chart per lift, sets per muscle group each week, a
weekly streak and a 12-week calendar), **routines** (yours, three starter
templates, and an optional AI 4-week plan), and export / import as JSON or
CSV.

Built 2026-10-26 as an **everyday** drop (health and hobbies): Proof
(2026-10-25) was a business one, so today was the other kind. **Staging
only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/rep`,
served at `challenge.strongtechnicalconsulting.com/rep/`, data in `rep_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (everyday life)

People who lift keep their numbers in a notes app or forget them, stand at
the rack guessing what to put on the bar, rest too long or too short, and
never see their progress. The fix is small and specific: last time's numbers
beside this time's, one rule for what to try next, a timer, and the plate
maths done for you.

**Who it's for:** anyone doing strength training, beginner to intermediate.

**Not a repeat:** nothing in the lab or the portfolio logs training. Hike is
a business's pay rises, Sprout is plants, Pawlog is pets.

**Who pays.** Almost nobody. Logging, the timer, plates, suggestions, PRs,
charts, routines, the starters, the sample, export and import are free, need
no account and make no model call. A **free** account adds sync. The one
metered thing is **"Plan my next 4 weeks"** (Haiku for the free tier, Sonnet
for members via `identity.planFor`), about two cents.

**How it becomes an iPhone app.** A Live Activity for the rest timer (the
countdown on the lock screen), local notifications at zero, HealthKit to save
each workout as a strength-training session, the Apple Watch for logging a
set and feeling the buzz, and widgets for "Up next: Full body B" and the
streak.

## The decisions that matter

- **One rules file, run three times.** `public/rep-core.js` is UMD
  (`window.RepCore` in the page, `require` in the server and tests): cleaning,
  units, the library, a workout, sessions, the suggestion, PRs, weeks and
  streaks, the rest timer's sums, plates, routines, import / export, the AI
  brief and plan validation, the sample. **No clock and no dice**: everything
  that needs "now" is handed it (tested: no `Date.now`, `new Date()` or
  `Math.random` in the file).
- **Units.** Weights are stored in **kilograms, rounded to 0.1 g**
  (`toKg`), and shown in the lifter's choice (`shown`, two decimals). Any kg or
  lb value with up to two decimals comes back exactly (tested over 0-700 in
  0.25 steps and some awkward values). Switching units changes nothing
  stored. Increments and plates are worked in the display unit, so a kg
  history shown in lb suggests a weight a lb bar can make.
- **Days are civil days** (`YYYY-MM-DD` in the lifter's zone, written by the
  phone when the workout starts) and the sums run on UTC midnights, so a
  clock change never moves a workout or miscounts a week. Weeks run Monday to
  Sunday. The suite runs the same streak, calendar and weekly-set sums in six
  zones and gets byte-identical answers.
- **e1RM is Epley**, `w x (1 + reps/30)`; a single is itself; over 15 reps
  there is no estimate.
- **"Beat last time"** (`suggest`), from the last session of a lift: "done"
  means every set at the top weight reached the goal (the routine's reps, else
  the first set's), with at least the goal's number of sets. Only a routine
  sets a goal: an exercise added on the fly plans three sets but is judged on
  what was done, so two good sets are not "a missed set". Done: add the
  increment - lower-body barbell and machine lifts 5 kg / 10 lb, everything
  else 2.5 kg / 5 lb - rounded to what the bar can make (2.5 kg / 5 lb), never
  below last time; done but the top set was RPE 9.5 or 10: repeat it once.
  Missed: stay; twice at the same weight: "a third miss means a deload"; three
  in a row at the same weight: deload 10%, rounded. Bodyweight with no added
  weight: add a rep, or stay (never a deload). Warm-ups never count.
- **PRs** (`setPrs` live, `sessionPrs` for a session, `timeline` for a lift
  in one pass): heaviest weight, most reps at a weight, best e1RM (only once
  there was one to beat), most volume (reps for bodyweight). Never on a first
  session, never on a warm-up. A PR logged mid-workout gets the celebration
  (confetti of plates, none under reduced motion); finishing lists them all.
- **The rest timer is a start timestamp and a length**, stored with the
  workout under way (`rep-active-v1`): `restLeft(start, secs, now)` rounds up,
  never goes below 0 or above the length, and a phone locked for an hour or a
  clock moved back gives the right answer. It starts after each logged set
  (warm-ups at most 60 s), adjustable by 15 s, at the lift's own rest (or the
  lifter's choice for that lift, remembered). At zero it vibrates and beeps
  where the browser allows (an `AudioContext` made inside the tap that logged
  the set); the screen always says so.
- **The plate calculator** (`plateMath`) works in hundredths with the pairs
  you have of each size (configurable, kg and lb sets, and the bar), by
  reachability rather than greedily, so 60 kg on 15s and 10s comes out as
  10 + 10 a side. Heaviest first among the loads that work. Not makeable: the
  nearest below and above, each with its plates; less than the bar, or more
  than your plates, says so.
- **The workout screen**: the exercises and sets scroll above; the console
  (weight and reps steppers, holding repeats, RPE chips, warm-up, "same as
  last", "Log set") and the rest timer are one dark panel pinned to the
  bottom on a phone and a sticky right column on a desktop. Tapping a set
  selects it; a logged set edits in place. Minimise keeps it going. The
  workout under way is saved after every change, so a reload loses nothing.
- **Routines**: three **starter templates** (Beginner full body A/B, Push /
  Pull / Legs, 5x5 A/B), labelled "general templates, not advice"; your own
  (from a workout, a starter copy, the editor or the AI plan). "Up next" is
  the routine after the last one you did in its program, or the first of a
  freshly saved plan. A draft plans every set with the plan's % of your best
  e1RM in the last 8 weeks, else the plan's weight, else "beat last time".
- **The first run** is the hero, a kg / lb choice (guessed from the
  language), three doors (**Try a sample month**, Start a workout, Pick a
  starter routine), the privacy promise, a mock of the console with a "New PR"
  flag, and "How it works". **The sample** (`sample(today, now, unit)`) is a
  made-up lifter's last four-plus weeks, Monday / Wednesday / Friday on the
  beginner routine, in the lifter's unit with round numbers: squat and
  deadlift climbing, a bench PR in the last workout, an overhead press stalled
  three times at the same weight (so it suggests a deload), pull-ups up to
  3x8. Tested on six dates (including leap day and New Year's Eve) in both
  units. A strip says it is made up, with **Start my own** and **Clear the
  sample**; workouts logged while it is loaded belong to it.
- **A plain safety line** on every view and the workout screen: general
  information, not medical advice; warm up, use safety bars or a spotter, stop
  if something hurts.

## Export and import

`exportJson` (`{app: 'rep', version, unit, workouts, routines, exercises}`,
never the sample) and `importJson` (every item through the same cleaning; a
bad id, a future date or a set without a number is counted as skipped).
`exportCsv` (`Date, Workout, Exercise, Set, Weight, Unit, Reps, RPE,
Warm-up`), quoted where needed and **never a formula** (a leading `= + - @`
gets a quote mark). `importCsv` reads Rep's own CSV and the usual columns of
other apps' exports (a "Workout Name", "Exercise Name", "Set Order", a unit
in a column or the header); exercise names are matched to the library
(aliases like "Bench Press (Barbell)", "Pull Up", "Military press"), anything
else becomes a custom exercise; ids come from the date, workout and exercise,
so the same file twice adds nothing. 2 MB and 20,000 rows at most. The page
shows what it found before anything is merged (newer copy wins).

## "Plan my next 4 weeks" (the one model call)

`POST /api/plan`: `requireUser, requireBudget, requireDailyCap` **then** the
route's own 16 KB parser (a stranger's body is never read; tested
401/402/403/503, never 413), then `RepCore.cleanBrief` (a 400 costs nothing),
then one forced tool `plan_weeks`, max 4000 tokens, then
`RepCore.cleanPlan`.

- **What the model is told** is only the brief: goal (strength / size /
  general), days a week (2-6), equipment, unit, and per lift in the last 8
  weeks (16 at most) its sessions, best set, e1RM, last session and misses in
  a row - library ids, or a custom lift's cleaned name. **No name, no email,
  no notes, no dates** (tested on the brief, and on what the fake model was
  actually sent with a name, an email and a note in the body). The sheet
  shows the exact line that is sent.
- **The plan's shape**: the days of a week, each exercise with its rest and
  exactly four weekly prescriptions (sets, reps, a % of e1RM or a weight),
  which `planRoutines` turns into one routine per day per week ("Week 2 ·
  Upper") in one program, with any custom exercises it needs.
- **What `cleanPlan` enforces**: the days asked for at most, 8 exercises a
  day, library lifts (matched by id or name) or a clearly named custom one -
  never a bare "barbell" - only on the equipment given (bodyweight always),
  no duplicate in a day; sets clamped to 1-8, reps 1-30, a % kept only in
  30-100, a weight only 0 to the ceiling, rest 30 s - 10 min; always four
  weeks (the last good one carried on); no links, no markup. Nothing valid
  left is a 422.
- Proposed, saved only on a tap; nothing is stored or logged on the server.
  Signed out, the sheet explains it needs a free account and that everything
  else stays free; 402 opens the credit sheet; 403 `verify-email` shows its
  sentence.

## Sync (signed in, free)

Filed under an **owner tag**, an HMAC of the account id under a key derived
from `IDENTITY_SESSION_SECRET` ("rep log owner v1") - never the id or the
email. With no secret, sync answers 503 and the log stays on the phone.

- `months/<tag>_<YYYY-MM>` = `{owner, month, workouts: {<id>: workout}}` -
  one document per calendar month, so a document stays far under Firestore's
  1 MiB however long someone logs (120 workouts a month at most), and two
  phones saving in the same month both stick (transactions; twelve at once
  tested). An emptied month is deleted.
- `profiles/<tag>` = `{routines: {<id>}, exercises: {<id>}}` (80 and 100 at
  most).
- Routes: `GET /api/log`, `PUT|DELETE /api/workouts/:id` (delete takes
  `?day=`), `PUT|DELETE /api/routines/:id`, `PUT /api/exercises/:id`,
  `POST /api/log/merge` (sign-in and import: up to 150 workouts a request, the
  page sends batches; newer `updatedAt` wins; the sample never comes along),
  `DELETE /api/log` (the account's copy; the phone keeps its own). Each
  parser runs after `requireUser`. 300 writes per account in 10 minutes.
- **The only query** is `owner == tag` on `months`: one equality filter, no
  composite index.

## On the phone

`localStorage`: `rep-log-v1` (workouts, routines, custom exercises),
`rep-active-v1` (the workout under way, its rest timer and current set),
`rep-settings-v1` (unit, bar and plates per unit, workouts a week for the
streak, rest per lift, the timer's sound, vibration and auto-start, the
routine up next), `rep-tab-v1`. Every access wrapped. A service worker
(`sw.js`, network first) keeps the app's own files so it opens in a gym
basement, never `api/`. Views: Today (up next with each lift's planned
weight, beat last time, this week and the streak, recent PRs, tools), History
(by week; a workout opens with its sets, "Do it again", "Edit sets", save as
a routine, delete), Progress (tiles, an e1RM / heaviest / volume chart per
lift with a crosshair readout, records, sets per muscle this week or last
against the average, the consistency calendar), Routines (the AI plan box,
yours by program, the starters). Bottom tab bar on a phone, a left rail on a
desktop (`desktop.css`).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page. Signed in, free:
the sync routes above. Metered: `POST /api/plan`.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8139/rep/
npm test        # pure rules first, then end to end over HTTP under a /rep mount
```

`REP_MEMORY=1` and `REP_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`) -
in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `REP_COLLECTION_PREFIX` (set to `rep_` by the lab
host) prefixes every top-level collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that does not
force a tool, keeps what it was sent (`fakeClient.seen`), and reads triggers
in a custom lift's name: `BLANK`, `INJECT`, `MAXTOKENS`, `UPSTREAMnnn`.

`test/run.js` (21 tests): cleaning and hostile strings; unit round trips in
both systems; Epley; plates (exact in kg and lb, impossible weights below and
above, under the bar, more than your plates, a set greedy cannot solve, micro
plates, limited pairs, every exact answer re-added); the suggestion (each
increment, both units, a kg history in lb, misses, the deload, a missed set,
RPE 10, warm-ups, bodyweight); PRs (each kind, live and per session, never
first, never a warm-up, bodyweight); the rest timer's sums (rounding, a locked
phone, a clock moved back, adjusting); streaks, weeks and the calendar across
both 2026 clock changes and in six zones; routines (starters valid, up next,
drafts with % of e1RM and suggestions, finishing); export and import (JSON
round trip, refusals, CSV quoting and formulas, our CSV back in, another
app's CSV, the same file twice, hostile cells); the sample on six dates in
both units; the AI brief and plan validation; contrast in both themes; the
local-only switches; the prefix and the one query; the page (no inline
script or handlers, relative URLs, wrapped storage, no email, no clock in the
core, every typed string escaped, the safety line); and over HTTP: signed out
with zero model calls and 401s before the parsers, the gate order, sync
across two phones with nothing identifying stored, the plan (bad requests
before spend, what the model sees, hostile output, errors not passed on,
nothing stored), and the 401/402/403/503 gates. The shared files
(`lib/identity.js`, `identity-store.js`, `byok.js`, `stripe.js`,
`webauthn.js`; `public/desktop.css`, `passkey-client.js`, `verify-banner.js`)
are synced copies - edit them in `eriks-projects/shared/` (and `lib/` for
`identity-store.js`).

## What is deliberately not built

- **Advice.** The starters and the AI plan are general templates, said so on
  the page; nothing claims to know what is safe for a body.
- **Cardio, timed holds and supersets.** Sets are weight x reps; a plank is
  not in the library for that reason.
- **A social feed or leaderboard.** Numbers are personal; nothing is shared.
- **Reminders from a server.** There is no sender; an iPhone app would use
  local notifications.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`, handlers by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the metered route's gates run
  before its parser, and every sync parser runs after sign-in.
- Every typed string, every imported cell and every model field is untrusted:
  cleaned in the core and escaped on render. Checked in Chromium with a
  hostile workout name, exercise name, note and imported CSV through every
  view, sheet and the celebration, with no CSP violation and no injected
  element.
- Failures (`fail()`/`failure()`, Receipt's): only the app's own errors reach
  the page in their words; a provider error is a 502 (503 "The AI is busy").
  Nothing logged carries a workout, a note or a brief.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
