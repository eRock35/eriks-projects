# For Claude: Tipout

Split the tip pool at close, to the cent, and show your working. A shift lead,
a bar manager or an owner with 3 to 30 people on a shift **sets the pool rules
once** — from one of three templates: **hours-based** (everyone in the pool by
hours worked), **points** (role points × hours: server 1.0, bartender 1.2,
busser 0.5, host 0.4), or **tip-outs first** (the bar gets 10% of the tips, the
kitchen 3% of food sales, then the rest is split by hours or points) — with
editable roles, points, percentages and a roster of **first names only**. At
close they **tick who worked**, set hours with steppers and presets ("Set ticked
to 6h", a sheet of 3–12h, ± a quarter hour), type **card tips, cash tips** and,
if a tip-out needs it, **food sales** — or **snap the POS report** and a model
reads those three numbers once. The split draws as they type: every share in
dollars and cents, card and cash separately, the arithmetic in words under each
name, and **"Paid out $1,601.60 = tips in $1,601.60 — balanced to the cent"**.
The **cash envelope builder** takes the drawer count (steppers per bill) and
says which bills go in whose envelope, or plainly that the drawer can't make
exact change and which bill to break. **Save & share** mints a link for the
whole shift and one per person, each with a **QR code** to scan at close, sent
with the share sheet or copied; staff open them with no account. **History** is
the week: totals per person, tips per hour, a bar per day, and a **CSV**. A
**heads-up** appears when a role marked manager or supervisor would take money
from the pool.

Built 2026-09-27 as the tenth of Erik's lab drops, after Spar, Snapquote,
Chaser, Rave, Pop Quiz, Glowup, Booth, Receipt and Tally. **Staging only**: no
custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab — `challenge/apps/tipout`,
served at `challenge.strongtechnicalconsulting.com/tipout/`, data in `tipout_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

Restaurants, bars and coffee shops pool tips and split them at the end of every
shift. It is done by hand on the back of a receipt or in a fragile
spreadsheet, at 1 a.m., by the person who most wants to go home — and it causes
real disputes, because the staff can't see how their number was worked out. A
cent lost to rounding, a busser's share computed on the wrong hours, a cash
envelope that comes up $3 short because the drawer had no singles: each is
small, and each is a conversation the next day that nobody enjoys. Payroll and
POS systems that do tip pooling exist, but they are priced and built for groups
with an HR department; a twelve-seat bar has a calculator app.

Tipout is the calculator that shows its working. The **transparency receipt**
is the point: the same arithmetic the shift lead saw, in words, on the phone of
the person it is about.

**A free pick.** Friction's rising problems that day were back-office
reconciliation work, and Tally had just covered card settlement. Tipout sits
next to Friction's "Cash collected by riders and marketplaces can't be attributed or settled" problem
(named by title only): the tip jar is exactly the cash that has to be
attributed to people and settled every night.

**Who pays.** Nobody, for almost all of it: the split, the envelopes, the
arithmetic, the copy-as-text receipt and the sample never need an account;
saving shifts, the week, the CSV and receipt links need a free one (they are
stored) and never call a model. Snapping the POS report is about a cent on
Haiku. The membership buys the better model.

**How it becomes an iOS app.** The camera for the POS report, the share sheet
for receipts, a Live Activity at close ("4 of 9 envelopes packed"), and the
drawer count from a photo of the bills. The data model does not change.

**The honest risk.** Tipout does the arithmetic the house rules describe; it
does not know whether the rules are lawful where the bar is (tip credits, who
may be in a pool and which states cap tip-outs vary), whether hours are right,
or whether the cash counted is the cash taken. It is not payroll: "card" means
paid with the card tips through payroll, and nothing here files, withholds or
reports anything. The manager heads-up is informational and says so. A POS
report photo is a proposal the shift lead checks.

## The decisions that matter

- **One rules file, run twice.** `public/rules.js` is UMD: the page loads it as
  `window.TipoutRules`, the server `require`s it. Validation, the split, the
  rounding, the envelopes, the heads-up, the receipt text, the share card, the
  week and the CSV. The phone at close, the staff member's link, the saved
  history and the tests compute the same cents from the same code.
- **Integers only.** Money is cents, read from the typed digits (`toCents`,
  never through a float); hours are quarter-hours; points are hundredths;
  percentages are basis points. Every weight × amount stays far below 2^53.
- **Rounding never loses or invents a cent** (`allocate`): largest remainder —
  everyone gets the floor of their exact share, then the leftover cents go one
  each to the largest remainders, ties to the larger weight and then list order,
  so it is deterministic. Each piece (a tip-out, the rest, the pool) is
  allocated on its own, and a person's line says "(incl. 1¢ rounding)" when
  they got one. The tests run 10,000 random splits and 150 thirty-person
  shifts and check paid out == taken in, to the cent, every time.
- **Card and cash, separately.** A person's total share is computed first;
  then the cash is shared in proportion to those totals, **never more cash than
  the share**, and card is the rest — so card + cash is the share to the cent,
  and the card total + cash total is the pool. With **whole-dollar envelopes**
  (the default) cash goes out in dollars, and the odd coins stay in the drawer
  and go out with the card tips; the page says how much. When whole dollars
  cannot all be placed under everyone's share (a nearly all-cash night split
  many ways), the remainder goes the same way, never over anyone's share.
- **Tip-outs.** Each is a percentage of the tips or of food sales, rounded half
  up to the cent, taken in order and capped at what is left (never invented).
  It is shared by hours among the people in that role. A tip-out whose role
  nobody worked stays in the pool and says so; one on food sales with no sales
  typed waits and says so — and **a tip-out role never shares the rest**, even
  on a night its tip-out is skipped, so the kitchen cannot end up in the
  servers' pool by accident. If only tip-out roles worked, the rest is shared
  by everyone, with a note. A pool whose weights are all zero is an error, not
  money quietly lost.
- **Zero hours is zero.** Someone ticked with 0 hours gets $0.00 and a line
  saying why; a shift with nobody on hours cannot be split or saved.
- **The envelope builder** (`envelopes`) is an exact search, not a greedy
  guess: people largest first, each envelope filled from the largest bill
  down, backing off a bill at a time when the rest of the drawer cannot make
  the remainder (so $60 from one $50 and three $20s is three $20s). Bounded at
  200,000 steps; a search that finishes without a way is **proven** impossible
  ("The drawer can't make exact change"), one that runs out of steps says "we
  couldn't find a way". Either way it shows the best the drawer can do, each
  envelope's shortfall, and one fix: swap the smallest leftover bill that
  covers the biggest gap ("Swap one $10 from the drawer for smaller bills").
  A drawer short of the envelopes says by how much. Not counted: the fewest
  bills for each envelope, labelled as such.
- **The fairness heads-up** (`headsUp`) appears when a role marked manager or
  supervisor (by a tick, or by its name — "manager", "supervisor", "owner",
  "GM"…) would take money from the pool. It names them and the amount, says
  the US federal FLSA (since 2018) bars managers and supervisors from keeping
  tips from a pool, and ends "Check your state and local rules… This is a
  heads-up, not legal advice." It never changes a number. The sample has a
  floor supervisor on the roster, off tonight: tick her and it appears.
- **First names only, enforced.** `cleanName` keeps the first word and at most
  an initial ("Sam R."), letters and marks only — a surname typed by habit, or
  a formula, never reaches a receipt link or the CSV.
- **A shift is stored as its inputs** — date, part of the day, card, cash,
  sales, the crew (pid, first name, role, quarter-hours as they were that
  night), the drawer count and a **snapshot of the rules** — and the split is
  worked out again on every read. A later change to the team or the rules
  never rewrites an old shift. The page sends the dollars as typed and the
  server validates the same text (it once sent validated cents, which read
  back 100× too big; a test now holds page and server to the same split).
- **Receipt links** (`shares/<token>`): one for the whole shift and one per
  person, each **22 characters from 16 random bytes** — nothing about the
  shift or person is in it. `R.shareCard` builds each field by field: date,
  part of the day, the pool's totals, the method and its tip-outs, and first
  name, role, hours, money and the arithmetic — no drawer count, no account,
  no venue, no surname. A person's own link shows only their line plus the
  pool. Sharing again keeps everyone's link; **correcting a shared shift
  re-freezes its links at once** (a stale receipt is worse than none) and a
  person taken off loses theirs; Revoke and Delete kill them all. `/s/*` and
  `/api/shared/*` are GET-only (405), `no-store`, `no-referrer`, `noindex`;
  the page is the app itself with `<base href="../">`, drawn as a paper
  receipt. The owner opening their own link sees a "this is what staff see"
  note.
- **The QR code** is `public/qr.js`, Receipt's vendored copy of Kazuhiko
  Arase's MIT encoder (renamed `TipoutQR`): dark on white always, a full-screen
  view per link for scanning at the bar. Sharing uses `navigator.share` where
  the browser has it, else the clipboard.
- **The one model call** (`POST /api/snap`, forced tool `read_tip_report`)
  sits behind `requireUser, requireBudget, requireDailyCap`, **then** its 6 MB
  JSON parser — a stranger's upload gets a 401 unread, an empty wallet a 402
  unread (tested: 402, not 413). Every other route parses 128 KB. The photo is
  shrunk in the browser, checked by magic number before any spend (400), read
  once, dropped with the request; the store is dumped before and after to
  prove nothing was written. `ai.cleanReading` keeps only non-negative amounts
  with the cents read from the digits, under the per-shift cap; food sales
  must be food only (the model is told to leave a mixed total empty); no names
  are asked for or returned. The page fills the boxes, marks them "from the
  photo — check them" and shows the note, what was left out and the
  confidence. Only the app's own errors reach the page with their status; a
  provider error is a 502/503 with a plain sentence.
- **No model call and no write for a signed-out visitor.** The whole split,
  envelopes, team and rules editing work in the browser (localStorage) with no
  account; signing in copies a local pool to the account.
- **Billed per request.** No timers on the server, nothing after a response;
  the page's timers are a 500 ms debounce before saving team edits and toasts.

### Numbers

Hours method: share = hours ÷ total hours × pool. Points: role points × hours
÷ total points × pool. Tip-outs: bp × base / 10,000, half up, capped; each
split by hours within the role; the rest by hours or points. Tips per hour
(week) = a person's tips that week ÷ their hours in the pool, to the cent; it
excludes wages and says so. Denominations: $100, $50, $20, $10, $5, $1, 25¢,
10¢, 5¢, 1¢ (coins shown when the house pays coins, or on request).

Models: free tier Haiku 4.5, members Sonnet 5, via `identity.planFor` — the
same split as the siblings. A snap is ~1.6k input / ~100 output tokens.

## The first run

The landing shows a live receipt from the sample and two buttons. **"Try a
sample bar shift"** opens The Copper Fox's invented Friday dinner already
split — nine people, $1,284.60 card + $317.00 cash on $4,920 of food, kitchen
3% of sales and busser 8% of tips off the top, the rest by points, and a
drawer count that makes exact change — and everything on it can be changed,
nothing is saved, and "See a staff receipt" previews what a link shows. **"Set
up my pool"** is two screens: pick a template, type first names (Enter adds;
role picker beside it), then the split. The shift date defaults to last night
before 5 a.m.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8111/tipout/
npm test        # pure rules first, then end to end over HTTP under a /tipout mount
```

`TIPOUT_MEMORY=1` and `TIPOUT_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE` set) — in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `TIPOUT_COLLECTION_PREFIX` (set
to `tipout_` by the lab host) prefixes every top-level collection; the default
database is `challenge`. The fake model refuses any call that does not force a
tool. Photo byte triggers: `BLANK` unreadable (422), `NOTIPS` no tip totals
(422), `INJECT` messy values and an instruction in the note, `UPSTREAMnnn`
fails the way the SDK's APIError does; anything else reads $1,284.60 / $317.00
/ $4,920.00.

## Data (Firestore: `tipout_*` in the lab database `challenge`)

- `setups/<uid>` — method, restBy, cashDollars, roles `[{key, name, pts,
  manager}]`, tipouts `[{to, bp, of}]`, people `[{id, name, role}]`,
  shiftCount, updatedAt.
- `shifts/<uid>/items/<id>` — date, part, card, cash, sales (cents or null),
  crew `[{pid, name, role, q}]`, drawer `{"2000": 9, …}` or null, rules (the
  snapshot), share `{token, people: {pid: token}, at}` or null, createdAt,
  updatedAt. Under the owner's uid, so every route is a 404 for anyone else.
- `shares/<token>` — `{uid, sid, pid|null, createdAt, card}`: a frozen receipt.

Limits (`rules.js` LIMITS and `lib/shifts.js`): 60 people on a team, 40 on a
shift, 12 roles, 6 tip-outs of at most 50%, points 0–5, hours 0–24, $100,000
per amount per shift, 5,000 of a bill in a drawer, 8 shifts a day, 2,000
shifts a manager, a week view reads 60 shifts, a CSV covers up to 400 days.
Dates from ten years back to tomorrow. JSON bodies 128 KB except the snap
(6 MB after the gates; image 4 MB decoded).

Deleting a shift deletes its receipt links.

Accounts are the shared identity (`identity` database), mounted at `/api/auth`
— one account and one $2 credit across the lab and every app.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/demo`, `/api/shared/:token`, page
`s/:token`, and `rules.js`, `qr.js` (static). Signed in: `GET /api/me`,
`PUT /api/setup`, `GET|POST /api/shifts`, `GET|PUT|DELETE /api/shifts/:id`,
`POST|DELETE /api/shifts/:id/share`, `GET /api/week?start=`,
`GET /api/export.csv?from=&to=`. Metered: `POST /api/snap`.

## Ideas not built yet

- **Tip credit and wage awareness** — tips per hour plus the wage, by state;
  it needs a rules table kept current, which is a standing job.
- **Several venues or pools per manager** (a bar pool and a floor pool the
  same night).
- **A staff view** where each person sees their own week across shifts —
  needs accounts for staff, which the no-login receipt deliberately avoids.
- **Counting the drawer from a photo of the bills.**
- **Payroll export formats** (Gusto, ADP) beyond the plain CSV.
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
