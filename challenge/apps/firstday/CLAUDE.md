# For Claude: Firstday

A new hire's first week, planned in ten minutes - and nobody forgets the
laptop. Onboarding for **owners and managers of small businesses (5-100
people) with no HR team**. The manager picks a template, adds the new hire's
first name, the role, the start date, their own first name and a buddy, and
gets the whole plan: **before day 1** (equipment ordered, accounts created,
paperwork sent, the team told, a desk or locker, the welcome message),
**day 1 hour by hour**, **days 2-5**, and **check-ins at day 5, 30, 60 and
90** - every task with an owner role (Manager, Buddy, IT/admin, New hire) and
a due date counted in business days from the start. A **readiness meter**
says "7 of 9 done - uniform not ordered, buddy break not planned, 3 days to
go" and overdue tasks are called out. Three **role links**, no app and no
account: the new hire's opens a warm **welcome page** (where to go, when,
who to ask for, what to bring, the manager's message, the week, their own
to-dos, their check-ins); the buddy's and IT/admin's show only their own
tasks. Every link has **Add to calendar** (.ics). The first impression is
**"See a sample first week"**: a made-up cafe hire starting next Monday with
7 of 9 prep tasks done and the uniform overdue.

Built 2026-10-23 as a **business** drop: Kindly (2026-10-22) was an everyday
one. **Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/firstday`,
served at `challenge.strongtechnicalconsulting.com/firstday/`, data in
`firstday_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

A free pick on a business day: the run that built it had no access to
Friction (the deploy credential was missing), so no Friction problem is
named. The problem: at a small business a new hire's first day is usually
improvised - no laptop, no logins, nobody told the team, no plan - and
people decide in the first week whether they'll stay. With no HR team,
onboarding falls between the manager, whoever does IT and the team, and
nobody owns it. Not a repeat: Pop Quiz is training as a daily game (what
staff must know); Rota is shifts; Drill is incident rehearsal. Firstday is
the first week itself - who does what, by when, and how the person feels.

**Who pays.** Nobody, for almost all of it. The sample, a plan, the
templates, the meter, the three links, ticks, check-ins and the calendar
files need no account and make **no model call**. One thing is metered and
signed in: **"Tailor it to us"** (Haiku for the free tier, Sonnet for members
via `identity.planFor`), a cent or two.

**Not HR or legal advice.** The home page footer says right-to-work checks
and paperwork rules where you are still apply.

**How it becomes an iPhone app.** Push when the new hire answers a check-in
or a task goes overdue (the one thing a link can't do), EventKit instead of
the .ics, a widget with the day-1 countdown, and an App Clip from the new
hire's link so they install nothing.

## The decisions that matter

- **One rules file, run three times.** `public/firstday-core.js` is UMD
  (`window.FirstdayCore` in the page, `require` in the server and the tests):
  cleaning and refusals, business-day dates, civil time, templates, every
  change (`manage` for the manager, `linkAct` for a role link), readiness,
  overdue, the countdown, check-ins, the views, the .ics and the sample. **No
  clock and no dice** (tested): "now" and fresh ids are handed in. The sample
  runs the same `manage`/`linkAct` on the phone that the server runs in a
  transaction, so the demo cannot drift from the real thing.
- **Due dates are business days.** A task holds `offset` (working days from
  day 1, which is 0; -30..90) and `unit`: `bd` counts Monday-Friday, skipping
  the plan's own **holidays** (editable, up to 30); `cd` (only the 30/60/90
  check-ins) counts calendar days then rolls forward to the next working
  day. "We work weekends" counts Saturday and Sunday. Day 1 is the start
  date whatever day it is. `offsetFor` is the exact inverse of
  `shiftWorkdays` (tested over -30..90 on three calendars), which is how a
  picked date becomes an offset. Dates are civil (UTC-midnight sums), so a
  clock change never moves one; **times** (day 1's hour-by-hour, the
  arrival) are civil in the business's IANA zone and become real instants
  with `Intl` - the countdown across London's 25 Oct change is 3 days 1 hour
  (tested), and the .ics carries UTC instants.
- **Sections come from the date, not a field**: before (offset < 0), day 1
  (0, with optional times), days 2-5 (1-4), later (5+ or any `cd`). Moving a
  task "earlier/later" takes its neighbour's day and time and sits beside it.
- **Readiness** counts the business's prep before day 1 - the new hire's own
  to-dos (sign the contract, read the welcome) are theirs, not a measure of
  whether the business is ready. Missing items are listed earliest-due first
  in the task's own words (`miss`, e.g. "laptop not ordered"; every template
  prep task has one, tested), two named and "and N more". Levels: ready, on
  track, behind (something overdue).
- **What Firstday refuses to hold** (`sensitive`/`guard`, every typed field
  on every route, the check-in answers and the model's output too): a US SSN
  or UK National Insurance shape, the words for an ID (passport number, date
  of birth...), an IBAN, bank words (sort code, routing number, bank
  details), pay (salary, wage, an amount of $10,000+ or "45k", an hourly
  rate), any run of 9+ digits (an account, an ID or a phone number), an
  email address and "home address". Refused with a **422 and a sentence**
  naming the field ("What to bring: That looks like pay or salary..."),
  never quietly stripped, and nothing is stored. Allowed and tested: "Order
  the $1,200 laptop", "Bring $5 for parking", dates and times. A name is a
  first name and at most an initial (`firstName`, not copy).
- **Templates** (5): Front of house, Office / admin, Trades / field, Remote
  knowledge worker, Part-time / seasonal. Tested whole: every section, every
  owner, all four check-ins (d5 at bd 4, d30/60/90 at cd 30/60/90), day 1
  timed and in order, every prep task with a `miss`, nothing sensitive. A
  task can carry `only: [patterns]` - the office template gives an on-site
  hire a desk and a remote one a shipped laptop and a test call; hybrid gets
  both.
- **Check-ins** are a manager task with a `checkin` key. On the new hire's
  link each opens on its due date: how it's going (five faces), what's still
  unclear, what would help (500 characters each). Stored on the plan
  (`checkins.<key>`), so they go when the plan does. Only the new hire's link
  and the manager see answers. Before its day it is a 409 ("opens on Friday
  30 Oct"); the sample's preview passes `{early: true}` in the page only -
  the server never does (tested).
- **The sample** (`sample`): Fernhill Cafe (made up), Sam the barista
  starting next Monday, Mia managing, Jonah the buddy, the front-of-house
  template with 7 of 9 prep tasks done and the uniform overdue since
  Mon 12 Oct, Christmas and New Year as holidays (the 60-day check-in rolls
  past Christmas). Kept in `localStorage` so it survives a reload. From it:
  Preview each link exactly as that person sees it, fill in the day-5
  check-in early and see the answer on the manager's Check-ins tab, try
  Tailor (signed in), and "Use it for a real hire" (copies the tasks).

## Plans and links

Mirrors Rota's anonymous team, for a plan with three audiences.

- `plans/<CODE>` - one document: the plan, its tasks, the check-in answers,
  `links: {hire, buddy, it}`, `ownerHash`, `creator`, `expiresAt`. Every
  change runs in `store.transact` (tested: every link and the manager
  ticking at once, all land). `?since=v` answers `{same: true}`.
- `links/<CODE>` - `{plan, role}` and nothing else. **Three opaque codes per
  plan**, none of them the plan's own: the new hire's link cannot be turned
  into the buddy's, and the plan's code is not a link. The manager can
  replace any link (`relink`): the old code is deleted at once.
- **Codes**: 10 characters from 32 unambiguous ones (~10^15) - links, never
  typed. Unknown, malformed, replaced and expired codes read the same 404.
- **The manager** holds a 22-character key returned once on create, sent in
  `X-Firstday-Key` (never in a URL the server sees), kept in this phone's
  `localStorage` (`firstday-plans-v1`); the plan keeps
  `sha256(key + code)`. Anyone without the key gets the 404 a missing code
  gets. **"Copy my manager link"** puts the key after `#` (`p/<CODE>#k=...`)
  so the manager can open the plan on a laptop: the fragment never reaches
  the server, the page stores it and strips it from the address bar.
- **The device** gets an HttpOnly `firstday_k` cookie, path-scoped to the
  app, when it opens a plan; the plan keeps only a hash (`creator`) to count
  live plans per phone. Role links need no cookie.
- **What each link reveals** (`roleView`, tested by exact keys): first
  names (hire, manager, buddy), the role, the business, the start, the
  arrival time, the pattern and zone; **its own tasks** (title, due, time,
  done). The new hire's adds the welcome fields, the first week's schedule
  (day 1 and days 2-5, nobody's ticks) and their own check-ins with answers.
  Never: the holidays, the readiness meter, anyone else's tasks, another
  link's code, a key, a hash, the creator tag, or (on the buddy's or IT's)
  a check-in answer. The manager's view has everything but the hash, the
  tag and the key.
- **Limits** (`lib/plans.js` LIMITS; per instance, in memory): 10 new plans
  per address an hour (IPv6 by its /64), 500 across the instance; **8 live
  plans per phone** (a `creator ==` query); 30 **distinct** wrong codes per
  address in 15 minutes; 600 writes per address in 10 minutes; 80 tasks a
  plan; 30 holidays; a start from 30 days ago to 240 ahead.
- **Expiry**: 60 days after the last change, and **never before 120 days
  after day 1** (so the 90-day check-in always has a home). Checked on every
  read; the read that finds it expired deletes the plan and its links.

## Tailor it to us (the one model call)

`POST /api/tailor {about, role, pattern, template}`: `requireUser,
requireBudget, requireDailyCap` **then** the route's own 16 KB parser
(tested 401/402/403/503, never 413), then `ai.brief` (20-1,200 characters,
a role, the refusals - a 400 or 422 costs nothing), then whitespace streams
(`lib/stream.js`; from here failures are 200 with `{error, status}`) while
one forced tool `propose_plan` answers with tasks whose owner and check-in
are **enums** and whose offset is an integer -30..90. **No names are sent** -
only the description, the role, the pattern and the template it starts from
(tested). `ai.toProposal` keeps a task only if its fields have the right
types, its title is under 90 characters with no markup and nothing
sensitive, a time only on day 1, a check-in key once; at most 40; at least 8
with something before day 1 and on day 1, else a 422. It returns a
**proposal**: the sheet shows it by section, and only the manager's "Use
this plan" sends an ordinary `replaceTasks` (fresh ids, nothing ticked). The
description is never stored or logged (tested). Signed out, the button
explains it needs a free account and that the templates stay free.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `p/:code`,
`l/:code`. No account: `POST /api/plans` (`{plan, template}` or `{plan,
tasks}` to copy), `GET /api/plans/:code[?since=v]`, `POST
/api/plans/:code/manage` and `DELETE /api/plans/:code` (manager key), `GET
/api/l/:code[?since=v]`, `POST /api/l/:code/act` (`tick` its own; `checkin`
the hire's), `GET /api/l/:code/calendar.ics`. Metered: `POST /api/tailor`.
The manager's .ics is built in the page from the same core.

## On the phone

`localStorage` (every access wrapped): `firstday-sample-v1`,
`firstday-plans-v1`. The countdown ticks in the page from one instant - the
server is never polled for it; plans and links re-ask on foreground and
every 30 s. The service worker (`sw.js`, network first) never caches `api/`,
a plan or a link page.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8135/firstday/
npm test        # pure rules first, then end to end over HTTP under a /firstday mount
```

`FIRSTDAY_MEMORY=1` and `FIRSTDAY_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`.
`FIRSTDAY_COLLECTION_PREFIX` (set to `firstday_` by the lab host) prefixes
every top-level collection. The fake model refuses a call that does not force
a tool and answers from the closest template plus a task per tool the
description names; triggers `BLANK`, `INJECT`, `MAXTOKENS`, `UPSTREAMnnn`.
For `npm run dev` with a signed-in Tailor, also set
`REQUIRE_VERIFIED_FOR_FREE_AI=0` (no mail is sent locally).

`test/run.js` (24 tests): cleaning, first names and every refusal shape
(and what is allowed); business days across weekends, month and year ends,
leap day, Thanksgiving, Christmas, weekend workers and both DST changes, and
`offsetFor` as the exact inverse; the countdown in real hours across a clock
change; template integrity for every template and pattern; readiness and
overdue word for word; every manager change and its checks; role links
ticking only their own, check-ins only for the hire and only once open;
what each view holds by exact keys; the .ics (CRLF, folding, escaping,
all-day and timed events, UTC across a change, per role); contrast in both
themes and the lab card colours; the local-only switches; the prefix and
single-field queries; the page (no inline script, relative URLs, wrapped
storage, `esc()` everywhere, no clock in the core); and over HTTP: signed
out with zero model calls, a plan's whole life with all three links, what a
link reveals with hostile names, refusals storing nothing, codes/limits/
expiry, the gate order, Tailor end to end with hostile output, what the
model sees, the 401/402/403/503 gates, concurrent ticks. The shared files
(`lib/identity.js`, `identity-store.js`, `byok.js`, `stripe.js`,
`webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`.

## What is deliberately not built

- **Accounts for plans.** A plan is its links plus the manager key on a
  phone (and the manager link). Keeping keys on a signed-in account (an
  HMAC-tagged list, like Drill's library) is the first thing to add if Erik
  keeps it.
- **Binding the new hire's link to one phone.** The link is the key: whoever
  holds it sees what the new hire sees, including their check-in answers.
  The manager can replace it. A device claim like Rota's names would close
  that; not built because a new hire opens it on a laptop and a phone.
- **Documents, e-signature, payroll.** "Send the paperwork" is a task, not a
  file store - and pay, bank and ID details are refused on purpose.
- **Reminders by email or push.** There is no sender; links are shared by
  the phone's share sheet and the .ics carries the dates.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`, handlers by
  one `data-act` listener; every drawn field through `esc()`.
- No model call for a signed-out visitor, ever; the metered route's gates
  run before its parser.
- `p/*`, `l/*`, `/api/plans*` and `/api/l*` answer `no-referrer` and
  `noindex`: a code is a key to a person's first week. Only the app's own
  errors reach the page in their words; a provider error is a 502 (503 "The
  AI is busy"). Nothing logged carries a name, a task, an answer or a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
