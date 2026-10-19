# For Claude: Drill

Rehearse the bad day before it happens. A **tabletop incident drill** for a
small business team: a scenario told as timed **injects** ("Mon 9:42 AM ·
90 minutes in - the attackers offer a 20% discount if you pay today"), each
**addressed to a role** (Owner, IT, Ops, Comms, Finance, Legal/HR), with two
to four choices that **branch** the story. Run it as a **room** - a code and
a QR, everyone on their own phone, no app and no account - where everyone
votes and the facilitator locks the call, or **solo** on one phone playing
every role. It ends in an **after-action report**: a readiness score per
checklist area, what went well, the three gaps to fix, an action list with
owners, and the timeline of decisions, as Markdown or a printable page. The
first impression is **"Try a 5-minute drill"**: four decisions, solo, no
setup, with a gentle 45-second pressure clock.

Built 2026-10-19 as a **business** drop: Boomerang (2026-10-18) was an
everyday one, so today was the other kind. **Staging only**: no custom
domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/drill`,
served at `challenge.strongtechnicalconsulting.com/drill/`, data in
`drill_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

Most small businesses (5-200 people) have **no incident plan**, and the few
that have one have never said it out loud with the people who would be on
the call. Yet **insurers and auditors ask for it**: "have you run a tabletop
exercise?" sits on cyber-insurance and audit questionnaires, and
**consultants charge thousands** to facilitate a half-day one. Drill is that
exercise for an hour of the team's time, with a report to hand over.

A free pick for a business day. One scenario, **"The AI agent that emailed
the wrong people"**, answers the Friction problem titled **"Agentic AI in
production triggered a reportable compliance incident on day one"** (title
only). Not a repeat: **Leash** (2026-09-30) maps what one AI agent may do and
includes three solo bad-day cards about that agent; Drill is a **team
rehearsal** of any bad day, run live on everyone's phone, with a report.

**Audience:** owners and managers of small businesses and their IT person,
office manager, whoever would be on the call.

**Who pays.** Nobody, for almost all of it. The five scenarios, the demo,
solo play, rooms (opening one and joining one) and the report are free, need
no account and make **no model call**. One thing is metered and signed in:
**"Make it about us"** (Haiku for the free tier, Sonnet for members via
`identity.planFor`), a few cents.

**Not legal advice, anywhere.** A regulator point is always "check the rules
where you operate" or "with your lawyer, check which breach rules apply",
with examples only as examples (GDPR's 72 hours, a US state breach law, the
FBI's IC3, Action Fraud). The page footer, the report and both exports carry
`Core.NOT_ADVICE`; the model's system prompt says the same; `test/run.js`
fails on "you must report", "legally required", "is reportable" and friends.

**How it becomes an iPhone app.** The room is already phone-shaped. An App
Clip from the QR so nobody installs anything, a Live Activity with the
decision clock, haptics on a new inject, the report through the share sheet.

## The decisions that matter

- **One rules file, run three times.** `public/drill-core.js` is UMD
  (`window.DrillCore` in the page, `require` in the server and tests): the
  roles, the seven areas, the checklist, the scenarios, `cleanScenario`, the
  clock, votes (`tally`, `leading`, `worstChoice`), the score and the report
  (object, Markdown, printable HTML). No clock and no dice of its own.
- **The checklist is one list** (`ITEMS`, 18 items in seven areas: Command,
  Contain it, Preserve evidence, Insurer & experts, Rules & reporting,
  Customers & staff, Recover). Every scenario - built-in or custom - tests
  items from it, so reports read the same whichever drill was run. Each item
  carries what "good" looks like, the fix and its owner role; the report's
  "went well", "three gaps" and action list come straight from it.
- **A scenario** is `{id, title, emoji, blurb, start: {day, time}, minutes,
  injects}`; an inject is `{id, at (minutes of scenario time), to (a role),
  title, text, tests (1-3 items), choices: [{id, text, then, next (an inject
  or 'end'), hits ({item: 1 or 2})}]}`. Six to nine injects with one or two
  branches (a weak choice leads to an extra inject where things got worse);
  the demo has four.
- **One door: `cleanScenario`.** Bounded counts and lengths, markup/control/
  bidi stripped, known roles and items only, hits only on tested items and
  only 1 or 2, every choice has a consequence, no two choices alike, at least
  one fully-right and one weak choice per inject, the first inject at minute
  0, **every edge goes forward in time** (so every path ends), every inject
  reachable, something ends. The tests hold every built-in to it unchanged,
  so a custom scenario can never be worse-formed than what ships.
- **Scoring** (`score`): per tested item, 2 points possible per inject that
  tests it, the choice's hits earned. Area % and overall % from the sums;
  bands Ready (80+), Partly ready (50+), Gap, and "Not tested here". Every
  band and every tested item carries its word, never colour alone.
  `cleanDecisions` only accepts a real walk from the first inject.
- **Votes**: the leading choice; a tie goes to the first listed (never to a
  vote count trick); **no votes when the clock runs out is the team froze**:
  the choice that does least. No server timer: the deadline is stored, and
  whichever read or write finds it passed locks it (`resolveTimer`; billed
  per request).
- **The clock** reads like a real day: "Mon 8:57 AM · 45 minutes in", "Tue
  8:12 AM · 1 day in".

## Rooms

Mirrors Dibs and Flight, with one difference: **no account to open one**
(a built-in scenario), the way Boomerang makes a receipt link signed out.

- `rooms/<CODE>` - one document, so a poll is one read and `?since=v`
  answers `{same: true}`. Every change runs in `store.transact` (tested: six
  votes from three phones at once, one vote per person).
- **Codes**: 6 characters from 32 unambiguous ones (no I, O, 0, 1), about a
  billion, typed however ("abc-def"). Unknown, malformed and expired codes
  read the same 404, word for word.
- **The facilitator** holds a 22-character key returned once on create and
  sent in `X-Drill-Key` (never in a URL), kept in this browser's
  `localStorage` (`drill-host-v1`); the room keeps `sha256(key + code)`.
  Start, lock (the leading vote or a named choice), next, the timer, remove,
  end early and delete need it; anyone else gets the room's 404.
- **Everyone else** has an HttpOnly `drill_k` cookie, path-scoped to the
  app, minted on open or join; the room keeps `sha256(key + code)` per
  person, so one phone is unlinkable across rooms. A phone that joined gets
  its own seat back. Names are unique per room (folded).
- **What a room reveals** (`R.view`, tested by exact key lists): the code,
  the scenario's title and blurb, first names and roles as typed, random
  person ids, the current inject without consequences or scores, who voted
  for what, the decided timeline with what happened, and the report when it
  is done. Never a key or hash, the creator tag, a future inject or an
  unchosen consequence. The facilitator alone also gets `guide`: what each
  current choice leads to and scores ("don't read aloud").
- **Limits** (`lib/rooms.js` LIMITS; per instance, in memory - they slow a
  script, they do not stop a determined one): 20 new rooms per address an
  hour (IPv6 by its /64) and 2,000 across the instance; **10 open rooms per
  device or account** (a `creator ==` query); 24 people a room; 40 new people
  per address an hour; 30 **distinct** wrong codes per address in 15 minutes,
  then even a real one waits; 600 room writes per address in 10 minutes.
- **Expiry**: a room lasts **48 hours** from when it opened, checked on every
  read and deleted by the read that finds it expired. The page says so and
  offers the download. Reports are also kept in this browser
  (`drill-history-v1`, the last eight).
- A custom scenario is run from the facilitator's **saved list**, never from
  the request, and copied into the room so guests need nothing else.

## Make it about us (the one model call)

`POST /api/custom {about, tools, focus}`: `requireUser, requireBudget,
requireDailyCap` **then** the route's own 8 KB parser (tested 401/402/403/
503, never 413), then `ai.brief` (15-600 characters about the business,
tools up to 300, a known focus - a 400 costs nothing), then a full library
(12) refused (409, nothing spent), then whitespace streams (`lib/stream.js`;
from here failures are 200 with `{error, status}`) while one forced tool
`record_scenario` writes the scenario in the exact inject/choice/checklist
schema (roles and items as enums). `ai.toScenario` puts it through
`cleanScenario`; a refused one is a 422 sentence and **nothing is saved or
offered**. The model sees only the three fields typed for it; the description
is never stored or logged (tested: not in the store). A good one is saved to
`libraries/<account tag>` and offered with Play solo and Run with my team.
Signed out, the button explains it needs a free account and that the
built-ins stay free; 402 opens the credit sheet; 403 `verify-email` shows its
sentence and "Send the link again".

## Data (Firestore: `drill_*` in the lab database `challenge`)

- `rooms/<CODE>` - `{code, scenarioId | custom, createdAt, updatedAt,
  expiresAt, v, hostHash, creator, timerSec, phase, current, deadline, votes,
  decisions, people: [{id, name, role, keyHash, host, joinedAt}]}`. 48 hours.
- `libraries/<account tag>` - `{scenarios: {<id>: scenario + createdAt},
  createdAt, updatedAt}`, the tag an HMAC of the account id under a key
  derived from `IDENTITY_SESSION_SECRET` ("drill account v1"). With no
  secret, the library answers 503.

Queries are single-field equality (`creator ==`), so **no composite index**.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `r/:code`. No
account: `POST /api/rooms`, `GET /api/rooms/:code[?since=v]`, `POST
/api/rooms/:code/join|me|vote`, `POST /api/rooms/:code/host` (facilitator
key: `start|lock|next|finish|timer|remove`), `DELETE /api/rooms/:code`
(facilitator key). Signed in, free: `GET /api/library`, `DELETE
/api/library/:id`, a room from a saved scenario. Metered: `POST /api/custom`.

## On the phone

Solo drills and the demo never touch the server. `localStorage` (every
access wrapped): `drill-profile-v1` (first name and role), `drill-host-v1`,
`drill-history-v1`, `drill-solo-v1` (a solo drill in progress resumes on
reload). Exports are built on the phone (`Blob` downloads, `window.print()`
with a print stylesheet that shows only the report). A service worker
(`sw.js`, network first) keeps the app's files for offline solo play, never
`api/` and never a room page.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8132/drill/
npm test        # pure rules first, then end to end over HTTP under a /drill mount
```

`DRILL_MEMORY=1` and `DRILL_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`.
`DRILL_COLLECTION_PREFIX` (set to `drill_` by the lab host) prefixes every
top-level collection. The fake model refuses a call that does not force a
tool; triggers in the description: `BLANK`, `BACKWARDS`, `INJECT`,
`MAXTOKENS`, `UPSTREAMnnn`.

`test/run.js` (24 tests): cleaning; scenario integrity (every built-in
through the door unchanged, every inject reachable, every path ends and
moves forward in time, a right and a weak answer per inject, every role and
every checklist item used, the not-legal-advice wording); the clock; what
the door refuses; scoring (best walk 80+, worst walk 0 with three gaps,
owners, the timeline); decisions as a real walk; votes and the frozen team;
Markdown and HTML escaping; contrast in both themes; the local-only switches;
the prefix and single-field queries; the page (no inline script or handlers,
relative URLs, wrapped storage, every drawn field through `esc()`); and over
HTTP: signed out with zero model calls, the gate order, a room's whole life
with three phones, concurrent votes, the decision clock, what a room reveals
(hostile names included), codes and expiry, the anonymous limits, Make it
about us end to end, what the model sees, and the 401/402/403/503 gates. The
shared files (`lib/identity.js`, `identity-store.js`, `byok.js`, `stripe.js`,
`webauthn.js`; `public/desktop.css`, `passkey-client.js`, `verify-banner.js`)
are synced copies - edit them in `eriks-projects/shared/`. `public/qr.js` is
Dibs's vendored MIT encoder (Kazuhiko Arase), global renamed `DrillQR`.

## What is deliberately not built

- **Saving reports on the server.** A report lives in the room for 48 hours
  and on the phone after; the download is the record. An account-kept report
  history would be the first thing to add if Erik keeps it.
- **Editing a custom scenario by hand.** Delete and write another.
- **Sending invitations.** There is no sender; Share opens the phone's share
  sheet, or copies the link.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`,
  handlers by one `data-act` listener.
- No model call for a signed-out visitor, ever; the metered route's gates
  run before its parser.
- Every typed string, every custom scenario field and every server field is
  cleaned in the core and escaped on render; checked in Chromium with
  `<img src=x onerror=…>`, `"><svg onload=…>` and bidi overrides as names.
- `r/*` and `/api/rooms*` answer with `no-referrer` and `noindex`: a code is
  a key to the room. Failures (`fail()`/`failure()`): only the app's own
  errors reach the page in their words; a provider error is a 502 (503 "The
  AI is busy"). Nothing logged carries a name, a description or a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
