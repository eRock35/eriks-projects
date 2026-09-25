# For Claude: Booth

Trade-show leads that don't go cold. A small B2B team, a founder, a rep or a
maker works a trade show, a conference, a farmers' market or a pop-up. One
person starts the **event** (name, dates, place, what the booth cost, the
interests visitors ask about) and the team joins with an 8-character code.
Everyone **captures leads in ten seconds** — type the name, company, email and
phone, or **snap the business card or badge** — then qualifies: 🔥 hot /
🌤 warm / 🧊 cold, the interest chips, a next step (call, demo, quote, send
info) and a short note. Every lead gets a **follow-up clock**: hot goes cold
after 48 hours, warm after 5 days, cold after 14. A **free template** per
temperature, or a **draft in the rep's own voice**; copy it or open it in the
rep's mail app, then mark it sent / replied / booked / won (with the deal
value) / lost. A live **leaderboard** on the day, and a **show scorecard**
afterwards: follow-up rate within 48 hours, replies, meetings, pipeline and won
value against the booth cost — cost per lead and ROI — plus the list of leads
going cold right now. CSV export for the CRM, and a numbers-only **share
card**.

Built 2026-09-25 as the seventh of Erik's lab drops, after Spar, Snapquote,
Chaser, Rave, Pop Quiz and Glowup. **Staging only**: no custom domain until
Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab — `challenge/apps/booth`,
served at `challenge.strongtechnicalconsulting.com/booth/`, data in `booth_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

A booth is one of the most expensive things a small company buys — space,
travel, samples, printing, two days of everyone's time — and most of the value
evaporates on the drive home. The fishbowl of business cards sits on a desk;
the follow-ups go out a week late or never; the hot lead who said "call me
Tuesday" has heard from a competitor by Monday. Afterwards nobody can say
whether the show paid off, so next year's booth is booked on a feeling.

CRMs and badge-scanner rentals exist for enterprise teams at big shows. A
four-person roaster at a regional expo, or a maker at a weekend market, has a
notes app and good intentions. Booth is the shared list plus the one thing
that changes behaviour: **a clock on every lead**, visible to the whole team,
and a leaderboard that makes following up on time worth points.

**Who pays.** Nobody, for most of it: capture, the clocks, templates, the
leaderboard, the scorecard, the CSV and the share card never call a model and
are free forever. Reading a card or badge, and drafting a follow-up in the
rep's voice, are about a cent each on Haiku. The membership buys the better
model.

**How it becomes an iOS app.** Capture is the camera and the share sheet
(scan a card straight from the camera roll); the going-cold list is a
notification ("Dana goes cold in 3 hours"); the leaderboard is a widget on
show day. The data model does not change.

**The honest risk.** Booth sees only what the team types in. It does not send
email (there is no mail service), so "followed up" means someone tapped Mark
as sent; it does not read replies, so replies, meetings and wins are logged by
hand. ROI is only as honest as the deal values people enter, and "won" counts
whatever the team attributes to the show. The page says "follow up", not "we
followed up for you".

## The decisions that matter

- **One rules file, run twice.** `public/rules.js` is UMD: the page loads it
  as `window.BoothRules`, the server `require`s it. It holds lead validation,
  the clock, dedupe and merge, the status ladder, the leaderboard (points,
  streaks, badges), the scorecard, the templates, `mailto`, and the join-code
  format. The page ticks clocks every 30 s with the same `clock()` the server
  answers with, so a lead cannot be "going cold" in one and "fine" in the
  other.
- **One document per lead** (`events/<id>/leads/<leadId>`). Two staff
  capturing at the same moment write two documents; a status change is a
  merge on that one lead; nothing about a lead lives in an array on the event.
  Membership is a document per member plus `memberIds` written with
  `arrayUnion`/`arrayRemove`, so two people joining at once both land. The
  tests fire twelve concurrent captures from two staff and count twelve.
- **The clock** starts at capture: hot 48 h, warm 120 h, cold 336 h. States:
  `fresh`, `cooling` (the last quarter of the window, or under 12 hours),
  `cold` (past due, no follow-up), `done` (sent — `onTime` says whether before
  the window closed), `closed` (won or lost with no follow-up). Going cold
  lists the savable ones first, soonest first, then the ones already gone —
  late still beats never.
- **Status is a ladder** — new → sent → replied → booked → won — and climbing
  it stamps every rung it passes (a reply implies a follow-up went out), while
  stepping back clears the rungs above. Lost closes from anywhere. `sentBy`
  records who followed up: capture points go to the capturer, follow-up
  points and wins to whoever sent it.
- **Dedupe** by email (case-insensitive) or phone (digits, a leading US 1
  dropped) within the event. A capture that matches answers **409** with the
  match; the page offers **Merge** (gaps filled, interests added, the hotter
  temperature kept, the second note appended with its author — nothing already
  recorded is overwritten, the lead stays the first capturer's) or **Save as
  new** (`force: true`). Names alone are never matched — two Danas are common.
  A per-event queue (`exclusive`) keeps one instance's check-then-write
  honest; two instances could still both save a twin, and the merge is there
  for that.
- **Contacts are personal data.** Bounded lengths; an email must be an email,
  a phone 7–15 digits; markup stripped. They never go to the share card, never
  to the model (a draft gets the first name, company and role — not the email
  or phone), and never to a log: `fail()` logs a stack trace for our own
  errors and never a request body.
- **Every model call is a forced tool** (`write_followup`, `read_contact`)
  behind `requireUser, requireBudget, requireDailyCap` (`spend` in
  `server.js`), then the membership 404. An empty wallet 402s and a stranger
  404s with no model call; the tests count usage rows to prove both.
- **No invented facts in a follow-up, enforced in code** (`ai.validateDraft`,
  `guardBody`, `guardDetails`). The prompt gives only what was captured and
  asks for `[add: …]` gaps. Then the guard: a sentence claiming an attachment,
  a discount or "% off", a trial, free shipping, a promo code, a guarantee, a
  brochure or price list, a booked meeting or "as we agreed" — when the
  captured facts never mention it — is removed whole. A number, a price, a
  time, a weekday, a month, a link or an email address nobody captured becomes
  `[add: day]`, `[add: time]`, `[add: price]`, `[add: link]`… A bare number
  from the note may be used ("5 lb bags for 3 stores"), but a price, time or
  percentage only if captured as one ("3 stores" is not "3pm"). A subject that
  makes a claim falls back to the template's. The page lists what was taken
  out. The demo's two drafts pass through the validator untouched (tested).
- **A draft is only a proposal.** Nothing is saved and nothing is sent: the
  tests dump the store before and after. The rep edits it, copies it or opens
  a `mailto:` link in their own mail app, then taps Mark as sent.
- **The card photo is read once and kept nowhere.** Shrunk in the browser
  (1600px JPEG), checked by magic number and size *before* anything is spent
  (`lib/photo.js`, 400), read by the model, dropped with the request. Nothing
  readable → 422. An email or phone that is not valid is dropped and the page
  says so, rather than guessed. The snap route's 6 MB parser mounts **after**
  the sign-in, budget and membership checks (`memberOnly`), so a stranger's
  upload is never parsed; everything else is 128 KB.
- **Roles.** Everyone on the team sees every lead (it is the team's pipeline,
  not the rep's), the leaderboard (names and counts) and the scorecard, and
  can capture, re-qualify and change status on any lead. Only the owner edits
  the event, sees and resets the code, removes people, exports the CSV, and
  publishes or revokes the share card (**403** for staff). A lead can be
  deleted by whoever captured it or the owner. Anyone not on the team gets
  **404** on every event route, never 403. Leaving or being removed leaves
  your leads with the team.
- **Join codes are Pop Quiz's**: 8 characters from a 32-letter alphabet with
  no 0/O/1/I, `crypto.randomBytes` with rejection sampling, typed any way. Any
  wrong code gets the same 404; 8 wrong per person per 15 minutes (stored) and
  30 per address (in memory), and once blocked even the right code is refused.
  Resetting kills the old code at once.
- **CSV export escapes formula injection**: any cell starting with `=`, `+`,
  `-`, `@`, a tab or a carriage return gets a leading apostrophe, then normal
  quoting; UTF-8 BOM and CRLF so spreadsheets open it cleanly. A phone written
  `+1 404…` therefore exports as `'+1 404…` — the price of never running a
  badge's "company" as a formula.
- **The share card is frozen and aggregates only.** `E.shareCard` builds it
  field by field from the scorecard — counts, rates, money, dates, the
  interest-chip tallies, team size — never from a lead, never a teammate's
  name. One token per event (22 chars from 16 random bytes); Update re-freezes
  the same link, Revoke deletes it. `/s/*` and `/api/shared/*` are GET-only
  (405 otherwise), `no-store`, `noindex`, `no-referrer`; the page is the app
  itself with `<base href="../">`.
- **Everything is computed on read.** The clock, going cold, the leaderboard
  and the scorecard come from the lead documents every time. The only stored
  count is `leadCount` on the event (bumped on create/delete), used for the
  event list's number and nothing else.
- **No model call for a signed-out visitor.** The sample (`lib/demo.js`):
  Brightline Coffee Roasters — invented — at the invented "Southeast Food & Bev
  Expo 2026", three invented staff (Maya, Theo, Priya), twenty invented leads
  with `@…example.com` emails and 555-01xx phones, times relative to now so two
  are cooling and two have gone cold on every visit, a won/pipeline mix that
  paid the booth back 2.1×, and two hand-written drafts. The capture form works
  in the sample but saves nothing and says so.

### Numbers

Points: a lead 10, hot +5, followed up in time +10 (late +3), a reply +5, a
meeting +10, a win +25. The hot streak is consecutive hot captures by one
person, in capture order (current and best). Badges: First lead, Double
digits (10 leads), Hot hand (3 hot in a row), Quick draw (followed up within
an hour), Nothing went cold (5+ leads, every one followed up in time), Closer
(a win), Rainmaker (won more than the booth cost, alone). Ties share a rank.

Scorecard: within-48h rate is of all leads; reply rate is of followed-up
leads; pipeline is estimated deal values on open leads (not won, not lost);
ROI = (won − booth cost) / booth cost; coverage = (won + pipeline) / booth
cost. No booth cost → no ROI, never a divide by zero. The verdict: paid for
itself / the pipeline covers it / leads went cold / add the cost / early.

Models: free tier Haiku 4.5, members Sonnet 5, via `identity.planFor` — the
same split as the siblings. A draft is ~700 input / ~300 output tokens; a card
read adds ~1.5k input for the image.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8098/booth/
npm test        # pure rules first, then end to end over HTTP under a /booth mount
```

`BOOTH_MEMORY=1` and `BOOTH_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE` set) — in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `BOOTH_COLLECTION_PREFIX` (set to
`booth_` by the lab host) prefixes every top-level collection; the default
database is `challenge`. The fake model drafts from the prompt's own fields and
refuses any call that does not force a tool. Triggers: `INJECT` in a lead's
note adds markup, markdown, an attachment, 20% off, "Tuesday at 3pm", a link
and an address; `EMPTY` in a note returns nothing usable (422); a photo whose
bytes contain `BLANK` is unreadable (422), `BADGE` reads as a badge, `MESSY`
returns an invalid email and phone.

## Data (Firestore: `booth_*` in the lab database `challenge`)

- `events/<id>` — name, place, startDate, endDate, boothCost, chips, code,
  ownerId, `memberIds` (array-contains is how "my events" is found — no
  composite index), leadCount, shareToken, sharedAt, createdAt, updatedAt.
- `events/<id>/members/<uid>` — name (as the team sees it), role
  `owner | staff`, signoff, tone (`friendly | direct | warm | formal`, used by
  drafts), joinedAt.
- `events/<id>/leads/<leadId>` — name, company, title, email, phone, temp,
  chips, next, note, source `typed | card | badge`, status, value,
  capturedBy, capturedByName, capturedAt, sentAt, sentBy, repliedAt, bookedAt,
  wonAt, lostAt, mergedCount, updatedAt, updatedBy. One document each.
- `codes/<CODE>` — `{eventId}`: the join-code lookup.
- `joinfails/<uid>` — `{count, since}`: wrong-code attempts in the window.
- `shares/<token>` — `{eventId, uid, createdAt, card}`: the frozen card.

Limits (`lib/events.js` LIMITS, plus `rules.js`): 25 people a team, 20 events
run per person, 40 events per person, 1,000 leads an event, a show of at most
14 days, 12 interest chips of 24 characters, name/company/title 80, email 120,
phone 30, note 400, deal value up to $10M, booth cost up to $1M. JSON bodies
128 KB except the snap route (6 MB, after the gates; image 4 MB decoded).

Deleting an event deletes its leads, members, code and share link.

Accounts are the shared identity (`identity` database), mounted at `/api/auth`
— one account and one $2 credit across the lab and every app.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/demo`, `/api/shared/:token`,
page `s/:token`, and `rules.js` (static). Signed in: `GET /api/me`,
`POST /api/events`, `POST /api/join`, `GET|PUT|DELETE /api/events/:id` (PUT and
DELETE owner), `PUT /api/events/:id/me`, `POST /api/events/:id/code` (owner),
`DELETE /api/events/:id/members/:uid|me`, `GET|POST /api/events/:id/leads`,
`GET|PUT|DELETE /api/events/:id/leads/:lid`, `POST …/leads/:lid/status`,
`POST …/leads/:lid/merge`, `GET …/leads/:lid/template`,
`GET /api/events/:id/leaderboard`, `GET /api/events/:id/scorecard`,
`GET /api/events/:id/export.csv` (owner), `POST|DELETE /api/events/:id/share`
(owner). Metered: `POST /api/events/:id/leads/:lid/draft`,
`POST /api/events/:id/read` (card or badge photo).

## Ideas not built yet

- **A going-cold nudge** ("Dana goes cold in 3 hours") — needs a sender (push
  or email), which the platform deliberately doesn't have.
- **Reply detection** by connecting a mailbox (read-only, the Gmail pattern in
  trip-planner) so "replied" logs itself — a consent screen and a restricted
  scope; decide before building.
- **Assign a lead** to a teammate for the follow-up, with its own clock.
- **Year over year**: the same show's scorecards side by side, so next year's
  booth is booked on numbers.
- **A QR code at the booth** that lets a visitor type their own details into
  the team's list (a public capture form, rate-limited).
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
