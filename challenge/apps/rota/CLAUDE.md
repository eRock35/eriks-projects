# For Claude: Rota

Next week's shifts, fair and filled - without the group-chat chaos. A weekly
staff rota for **small hourly teams** (cafes, bars, restaurants, shops,
clinic front desks; 4-30 people). The manager sets up the week's shifts
(day, start, end, role, how many) from a **template** or **last week**, and
shares **one team link**: each person opens it on their own phone - no app,
no account - taps their name (or adds it) and marks next week **can /
prefer not / can't**, with hours if they have them, "no closes", their roles
and the hours they'd like. **Fill the gaps** builds the week without ever
breaking a rule, **explains every placement and every gap**, and a
**fairness panel** shows who has been short-changed over four weeks.
**Publish**, and everyone sees their shifts, adds them to their calendar
(.ics), and **offers swaps** that only rule-abiding teammates can claim; the
manager approves (or turns on auto-approve). Every change is **logged**.
The first impression is **"Try a sample cafe"**: eight made-up people,
availability in, an empty week, one tap to fill, one honest gap.

Built 2026-10-21 as a **business** drop: Duly (2026-10-20) was an everyday
one. **Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/rota`,
served at `challenge.strongtechnicalconsulting.com/rota/`, data in `rota_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

A free pick on a business day: the run that built it had no access to
Friction (the deploy credential was missing), so no Friction problem is
named. The problem is the everyday one of every small hourly business: the
week is built by hand in a spreadsheet or on paper, availability arrives by
text, swaps happen in a group chat nobody can follow, and someone always
ends up with too many closes or too few hours. Not a repeat: Tipout splits
tips, Chorus splits household chores, Pickup is a sports game; nothing else
in the lab or the portfolio schedules staff.

**Who pays.** Nobody, for almost all of it. The sample, a team, the link,
availability, Fill the gaps, fairness, publishing, swaps and the calendar
need no account and make **no model call**. One thing is metered and signed
in: **"Read their texts"** (Haiku for the free tier, Sonnet for members via
`identity.planFor`), a cent or two.

**Not employment-law advice.** Rota checks the rules the manager sets (rest,
max hours); the home page footer says minimum-break and hours rules where
you are still apply. Nothing claims compliance.

**How it becomes an iPhone app.** Push when the rota is published or a swap
is claimed (the one thing a web link can't do well), EventKit instead of
the .ics, a widget with "Next shift: Sat 7:30am Barista", and an App Clip
from the team link so staff install nothing.

## The decisions that matter

- **One rules file, run three times.** `public/rota-core.js` is UMD
  (`window.RotaCore` in the page, `require` in the server and the tests):
  cleaning, civil time in a zone, the rules, the solver, explanations,
  fairness, every change (`manage` for the manager, `staff` for a phone),
  the two views, the .ics, the templates and the sample. **No clock and no
  dice** (tested): "now" and fresh ids are handed in. The sample runs the
  same `manage`/`staff` on the phone that the server runs in a transaction,
  so the demo cannot drift from the real thing.
- **Time is civil in the business's zone, sums are real instants.** A shift
  is `{day, start, end}` in the team's IANA zone (`team.zone`); `wallToUtc`
  turns it into an instant with `Intl`, so a bar shift across the autumn
  change (20:00-03:00) is 8 real hours, rest is counted in real hours, and
  the .ics carries UTC instants (no VTIMEZONE needed). A time the clocks
  skip lands just after the gap; a repeated time takes the first. End <=
  start means it ends the next day. Tested in London and New York both ways.
- **The rules** (`blockers`, each a `{code, text}` in words): the role;
  "can't" that day; the hours a person gave ("only from 4pm"); "no closes";
  no overlap; **rest** (`team.minRest`, default 10 h) between two shifts on
  **different days** - a close and the next day's open; split shifts on one
  day are allowed - including last week's Sunday into this Monday; max
  hours. A close is a shift ending within 30 minutes of the day's closing
  time (or overnight); an open starts within 30 minutes of opening.
- **The solver** (`fill`): keeps every seat already filled (the manager's
  picks, swaps), then repeatedly takes the open seat with the **fewest
  people who could take it**, and gives it to the best fit (`preference`):
  can over not-marked over "prefer not" (more so for someone given
  prefer-nots lately), toward each person's target hours (relative and
  absolute, plus a nudge for anyone short last month), closes and weekends
  spread over this week and the last three, a small cost for people who can
  work many roles (save them for what only they can cover). Then a
  **repair** pass: a seat left open is retried by moving one of a blocked
  person's *filled* shifts to someone else - never the manager's picks.
  Deterministic: the same team gives the same rota (tested). A **gap** is
  reported only when nobody could take it, in one sentence with the
  decisive reason per person ("Sun 7:30am–3:30pm Kitchen: nobody available
  who can do Kitchen - Jonah can’t Sun · Lena can’t Sun") and a fix.
- **Explanations are derived, never stored** (`explain`): why this person
  (their availability, hours before and after against target, which close
  or weekend shift this is), who else could have and why this one was
  better, and who couldn't and why. The same `candidates` list feeds the
  seat sheet, so a manager tapping an open seat sees best fit first and
  "can't, and why" below, with "Put on anyway" - a manager may overrule a
  rule, and `conflicts` then flags it live with ⚠ and the rule in words.
- **Fairness** (`fairness`), judged over this week and the three before it
  that have anything assigned: hours vs target this week (0-60 off),
  closes and weekends each against a **fair share in proportion to the
  shifts worked over the four weeks** (0-25 off each), prefer-nots used
  this week (3 each). Bands Fair 80+, Mostly fair 60+, Uneven. Short-changed:
  15%+ under target over the window, 3+ closes or weekends over a fair
  share, 2+ prefer-nots given anyway. The panel says one week can only make
  up part of an unfair month.
- **Swaps** (`staff offer/claim`, `manage swap`): only on a published week,
  only before the shift starts; a claim runs `swapBlockers` - the same rules
  with the offerer's seat freed - and a phone only **sees** swaps it could
  claim. Approve re-checks; auto-approve applies at claim time when nothing
  breaks.
- **The sample** (`sample`): Fernhill Cafe (made up), eight people with
  next week's availability in (uni Mon-Wed, school run till 2pm, Sat after
  noon, no Sunday cooks), the cafe template, and three earlier weeks filled
  "the spreadsheet way" (first name on the list who can) so fairness has a
  story: fill places 32 of 33 seats, the one gap is Sunday kitchen, and the
  four-week score goes 33 → 60. Fixed ids, the same on every phone; kept in
  `localStorage` so it survives a reload. "Preview a staff phone" renders
  the staff view from it.

## Teams

Mirrors Drill's anonymous room, for something that lives for weeks.

- `teams/<CODE>` - one document, so a poll is one read and `?since=v`
  answers `{same: true}`. Every change runs in `store.transact` (tested:
  every person marking availability at once, all land).
- **Codes**: 10 characters from 32 unambiguous ones (~10^15) - a link,
  never typed. Unknown, malformed and expired codes read the same 404.
- **The manager** holds a 22-character key returned once on create, sent in
  `X-Rota-Key` (never in a URL), kept in this phone's `localStorage`
  (`rota-teams-v1`); the team keeps `sha256(key + code)`. The same link
  opens as manager on that phone and as staff everywhere else. Anyone
  without the key gets the 404 a missing code gets on every manager route.
- **Staff** have an HttpOnly `rota_k` cookie, path-scoped to the app; a
  person record keeps `sha256(key + code)`, so one phone is unlinkable
  across teams. One phone per name (409 otherwise); "Not me" lets go; the
  manager can free a name for a new phone.
- **What a link reveals** (`staffView`, tested by exact keys): the team's
  name, zone, roles, rest and auto-approve; **first names** (a name is a
  first name and at most an initial, by `firstName`, not by copy) and
  whether each is claimed; **published** weeks' shifts and who is on them;
  the viewer's own availability, roles and hours; swaps they made, claimed
  or could claim. Never anyone else's availability, notes or hours, a draft
  week, the log, a key, a hash or the creator tag. The manager's view has
  everything but the hashes.
- **Limits** (`lib/teams.js` LIMITS; per instance, in memory): 10 new
  teams per address an hour (IPv6 by its /64), 500 across the instance;
  **5 live teams per phone** (a `creator ==` query); 30 people a team; 40
  new names per address an hour; 30 **distinct** wrong codes per address in
  15 minutes; 600 writes per address in 10 minutes. A phone may only mark
  this week and the next four; a manager plans five weeks back to eight
  ahead; six weeks are kept - so nothing can push the history out.
- **Expiry**: 90 days after the last change, checked on every read and
  deleted by the read that finds it. Every write pushes it out.

## Read their texts (the one model call)

`POST /api/read-texts {text, names, week}`: `requireUser, requireBudget,
requireDailyCap` **then** the route's own 16 KB parser (tested 401/402/403/
503, never 413), then `ai.brief` (8-6,000 characters, the team's first
names, a Monday - a 400 costs nothing), then whitespace streams
(`lib/stream.js`; from here failures are 200 with `{error, status}`) while
one forced tool `record_availability` answers with the names and the seven
days as **enums**. `ai.toProposal` keeps a person only if the name is the
team's, a day only if it is one of the seven, a state only if it is can /
prefer / cant, times only if real and in order, max hours only 1-80, and
markup stripped everywhere; a message it cannot place goes to `unclear`. It
returns a **proposal**: the page shows it per person with ticks, and only
the manager's Apply sends an ordinary `availMany` change (days not mentioned
keep what they had). The pasted text is never stored or logged (tested).
Works in the sample too, for a signed-in visitor. Signed out, the button
explains it needs a free account and that everything else stays free.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `t/:code`. No
account: `POST /api/teams` (`{name, zone, template}` or `{sample: true}`),
`GET /api/teams/:code[?since=v]`, `POST /api/teams/:code/manage` (manager
key), `POST /api/teams/:code/join|leave|staff`, `GET
/api/teams/:code/calendar.ics` (this phone's shifts, this week on), `DELETE
/api/teams/:code` (manager key). Metered: `POST /api/read-texts`.

## On the phone

`localStorage` (every access wrapped): `rota-sample-v1`, `rota-teams-v1`.
The week shows **one day at a time below 1000px** (a day strip with a ! on
days that need a look) and all seven columns from 1000px. The service worker
(`sw.js`, network first) never caches `api/` or a team page.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8133/rota/
npm test        # pure rules first, then end to end over HTTP under a /rota mount
```

`ROTA_MEMORY=1` and `ROTA_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`.
`ROTA_COLLECTION_PREFIX` (set to `rota_` by the lab host) prefixes every
top-level collection. The fake model refuses a call that does not force a
tool and reads "Name: message" lines with a few patterns; triggers `BLANK`,
`INJECT`, `MAXTOKENS`, `UPSTREAMnnn`.

`test/run.js` (23 tests): cleaning and first names; time and two DST weeks;
the solver against an independent rule audit on 300 seeded random teams
(never a can't, role, window, no-closes, overlap, rest or max-hours break;
every open seat reported; deterministic) and honest gaps; the sample (32 of
33, the one gap word for word, fairness up 15+, the heaviest closers close
least, every placement explained); fairness; swaps only to eligible people,
approval and auto-approve, the log; week bounds; the .ics (CRLF, folding,
UTC across a clock change, escaping, own shifts only, this week on); the
views; contrast in both themes; the local-only switches; the prefix and
single-field queries; the page (no inline script, relative URLs, wrapped
storage, `esc()` everywhere); and over HTTP: signed out with zero model
calls, a team's whole life with several phones, what a link reveals with
hostile names, codes/limits/expiry, the gate order, Read their texts end to
end, what the model sees, the 401/402/403/503 gates, concurrent writes.
The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`.

## What is deliberately not built

- **Accounts for teams.** A team is its link plus the manager phone's key;
  a manager on a new phone has no way back in. Keeping the key on a
  signed-in account (an HMAC-tagged list, like Drill's library) is the
  first thing to add if Erik keeps it.
- **Drag and drop.** Tap a seat to change it; the seat sheet shows the
  ranked candidates, which is what a drag would need anyway.
- **Pay, labour cost and legal rules** (breaks, minors' hours, predictive
  scheduling laws). Rota keeps the rules the manager sets.
- **Notifications.** There is no sender; Share opens the phone's share
  sheet, and the page re-asks on foreground and every 30 s.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`, handlers by
  one `data-act` listener; every drawn field through `esc()`.
- No model call for a signed-out visitor, ever; the metered route's gates
  run before its parser.
- `t/*` and `/api/teams*` answer `no-referrer` and `noindex`: a code is a
  key to the team's names. Only the app's own errors reach the page in their
  words; a provider error is a 502 (503 "The AI is busy"). Nothing logged
  carries a name, a message or a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
