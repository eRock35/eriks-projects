# For Claude: the Challenge Lab

`challenge.strongtechnicalconsulting.com` — where Erik's "new app every day"
experiments live while they are being tested. Erik asked for it on
2026-09-24: one fun landing page for the test apps, each app at `/<slug>`,
and the ones he likes get moved to a dedicated subdomain.

## One service, many apps — on purpose

The lab is **one** Cloud Run service (`challenge`), **one** Firestore database
(`challenge`) and **one** runtime account (`challenge-run@`). Every trial app
is an ordinary Express app in `apps/<slug>/`, exported from its `server.js`
and mounted by `server.js` here at `/<slug>/`.

That is the whole point: a new app needs **no new infrastructure** — no
service, no database, no runtime account, no IAM change. Creating an account
and binding roles is the one step the deployer cannot do (it has no IAM-admin
rights, deliberately), so one-service-per-trial would have put Erik on the
critical path of every drop. Here he did it once.

Same reasoning as trip-planner's "one app, many trips": don't let "give each
trial its own deploy" creep back in. Graduation is when an app gets its own.

## How an app lives here

- **Data**: before requiring an app, the host sets `<SLUG>_COLLECTION_PREFIX`
  to `<slug>_`, and the app's `lib/store.js` prefixes every top-level
  collection with it (`spar_players`, `snapquote_quotes`, …). Apps never touch
  each other's collections, and graduating one is a copy of one prefix.
- **URLs**: every browser URL in an app is relative to `BASE`
  (`location.pathname` up to the last slash), and asset links in its
  `index.html` are relative. `/<slug>` redirects to `/<slug>/` so they resolve.
  The redirect checks the raw path — Express matches `/spar/` against a
  `/spar` route, and the first version redirected `/spar/` to itself forever.
- **Sign-in**: every app mounts the shared identity at its own
  `/<slug>/api/auth`. The cookie is `Path=/` and, with
  `PASSKEY_RP_ID=strongtechnicalconsulting.com` on the service, scoped to the
  whole domain — so one account (and its $2 credit) works across the lab and
  every other app, and Face ID works on the subdomain.
- **Isolation**: one broken app must not take the lab down; a failed `require`
  is logged and that app is simply not mounted.
- **Local**: `npm run dev` (port 8095) sets `<SLUG>_MEMORY=1` and
  `<SLUG>_FAKE_AI=1` for every app. Each app's own tests mount it under its
  slug too, so the base path is always exercised.

## Adding an app (what the daily routine does)

A Claude Code Routine fires every day at 07:00 UTC ("Challenge Lab: new app
every day"). Each run picks an idea, builds it, tests it, and ships it here —
two hours before the landing page's 09:00 UTC countdown turns over. It changed
from every other day to daily on 2026-09-24, at Erik's request; he decides
which drops earn their own domain.

**A daily run never creates infrastructure or changes IAM.** Everything it
needs already exists: this service, this database, `challenge-run@`. If an
idea needs a new secret, a bucket or a new API, it is the wrong idea for a
daily drop — pick another, and note the one that needs Erik. The lab ships
from `main`.

1. Build it in `challenge/apps/<slug>/` following Spar (`apps/spar/CLAUDE.md`):
   exports `{ app }`, listens only when run directly, BASE-relative URLs,
   `<SLUG>_MEMORY` / `<SLUG>_FAKE_AI` / `<SLUG>_COLLECTION_PREFIX`.
   Since 2026-09-27 (email verification, root CLAUDE.md) that also means:
   `<script src="verify-banner.js" data-mount="api/auth" defer>` in
   `public/index.html`, the app's `public/` line in
   `eriks-projects/scripts/sync-shared.js` listing `verify-banner.js`, and
   `REQUIRE_VERIFIED_FOR_FREE_AI=0` in its `npm test` script (its suite
   registers fresh, unconfirmed accounts and spends; the gate itself is held
   by the root suite and `test/lab.js`). `test/lab.js` fails if a mounted
   app does not load the banner.
2. Add its entry to `lab.js` (name, emoji, two colours, drop date, tagline,
   blurb, four features, audience, `status: 'testing'`).
3. Record what it cost to build (see "Build stats" below):
   `python3 scripts/token-ledger.py --stats <slug> <builder agent.jsonl>`
   (or `--workflow <dir>` for a workflow build), then add its row to
   `TOKENS.md`. Both are committed; the lab serves the JSON.
4. Draw its link preview: `npm run og` (here, in `challenge/`; `npm install`
   first so the devDependencies are there). It writes `public/og/<slug>.png`,
   redraws `public/og/lab.png` (the app count and the newest nine tiles
   change every drop), writes the `<!-- lab:og -->` tags into the new app's
   `public/index.html` and the landing's, and updates `og-manifest.json`.
   Look at the new PNG before committing it. Commit all of it. See "Link
   previews" below.
5. `npm test` here runs the host tests, the build-stats tests, the
   engagement and link-preview tests and every app's suite. `test/og.js`
   **fails if step 4 was skipped** or `lab.js` changed after it.
6. Commit, push, `gcpdeploy ship challenge`.

### Who the drops are for: alternate business and everyday (Erik, 2026-09-29)

The first thirteen drops were all small-business tools. Erik asked for
everyday people too: people at home, with friends and family, with their
own money, health, time and hobbies. Then he set the shape: **still one app
a day, alternating** between a business problem and an everyday one.

- **Which kind today:** the opposite of the newest drop in `lab.js`. Hike
  (business) and Dibs (everyday) both dropped on 2026-09-29, the day this
  was decided; Dibs is the newer, so 2026-09-30 is a business drop,
  2026-10-01 an everyday one, and so on. A missed day does not skip a kind:
  the next run still takes the opposite of the newest drop.
- **Holidays** keep their date and theme, and count as whichever kind they
  are; the next day is the other kind.
- **An inbox app idea** can be today's drop only if it is today's kind;
  otherwise it waits for the next day of its kind (mark it `seen` with a
  note saying when).
- The same bar for both: a real problem people have, genuinely fun,
  finished well, could be an iPhone app, not a repeat of a lab or portfolio
  app. An everyday app works for someone who never signs in (free first, the
  model only behind the usual gates) and is something a person would show a
  friend. Friction's problems are business ones, so Friction feeds the
  business days; everyday ideas come from ordinary life.

### Built on Erik's ask (2026-10-02)

Two everyday ideas Erik asked for in conversation, then asked to have built
the same day rather than queued. Both shipped on 2026-10-02 as Inside Joke
and Flight, so the newest drop is everyday and 2026-10-03 is a business day.
What he asked for, kept for the record:

1. **Game night -> Inside Joke.** Family/friends trivia generated from a
   group's own photos and group-chat exports - "who said it", "where was
   this", "what year" - with real multimodal work. The point Erik stressed:
   **playable when he is not with the people** (he travels a lot), so it
   needs an async mode (a daily round each person plays on their own time,
   a group leaderboard, streaks) as well as a live mode for a video call
   (room code, everyone on their own phone, like Dibs's table). Group-private:
   members only, photos kept only as small thumbnails the group can delete,
   chat exports read once and never stored (only the generated questions).
2. **Beer buddies -> Flight.** An app to
   share fun stuff with his beer friends. Not a repeat of Hopscotch (the
   portfolio's beer passport): a group thing - for example blind-tasting
   showdowns, "guess who brought it", voting on the next brewery or crawl,
   a crew leaderboard. If it can read a Hopscotch crawl or passport by its
   share link rather than duplicating it, better.

### Ideas from Friction (Erik, 2026-09-25)

Before picking, the daily run reads what Friction is hearing:
`node scripts/friction-spikes.js --text` (read-only; Firestore REST with the
deploy token, because the sandbox cannot reach Friction's web address). It
applies Friction's own rules from `apps/friction/lib/pulse.js` and prints the
spiking problems (3x their usual week), the rising ones and the strongest by
score, each with a one-line "could be an app" hint. Prefer one of those when it
fits; a holiday still outranks it. The app's CLAUDE.md names the Friction
problem by title only, never quoting anyone's complaint.

### Holiday drops (Erik, 2026-09-24)

On a holiday the day's drop is **themed for it** — "a Halloween, Thanksgiving,
Christmas one on those days". The run fires at 07:00 UTC, so it is live by
the morning of the day itself. Fun leads, but it should still be something
people actually use that day: a household or small-business job the holiday
creates, not a greeting card. The usual rules all still apply.

| Date | Holiday | Seeds (not binding) |
|---|---|---|
| 2026-10-31 | Halloween | costume/party planner, trick-or-treat route + candy-house map, a shop's spooky-promo kit |
| 2026-11-26 | Thanksgiving | oven & dish timeline, who-brings-what, leftovers planner |
| 2026-11-27 | Black Friday | small-shop deal builder, price-drop sanity check |
| 2026-11-28 | Small Business Saturday | shop-local passport, promo planner |
| 2026-12-25 | Christmas | gift budget + list sharing, family secret-Santa, thank-you notes |
| 2026-12-31 / 2027-01-01 | New Year's Eve / Day | resolution tracker, year-in-review for a business |
| 2027-02-14 | Valentine's Day | date planner, a restaurant's prix-fixe builder |
| 2027-03-17 | St. Patrick's Day | pub crawl / party planner |
| 2027-03-28 | Easter | egg-hunt planner, brunch booking |
| 2027-05-09 | Mother's Day | gift + brunch planner |
| 2027-05-31 | Memorial Day | cookout planner |
| 2027-06-20 | Father's Day | gift + grill planner |
| 2027-07-04 | Independence Day | cookout + fireworks-spot planner |
| 2027-09-06 | Labor Day | end-of-summer party planner |
| 2027-10-31 | Halloween | as 2026, or build on whichever 2026 holiday drop was kept |
| 2027-11-25 | Thanksgiving | 〃 |
| 2027-11-26 | Black Friday | 〃 |
| 2027-11-27 | Small Business Saturday | 〃 |
| 2027-12-25 | Christmas | 〃 |
| 2027-12-31 / 2028-01-01 | New Year's Eve / Day | 〃 |
| 2028-02-14 | Valentine's Day | 〃 |
| 2028-03-17 | St. Patrick's Day | 〃 |
| 2028-04-16 | Easter | 〃 |
| 2028-05-14 | Mother's Day | 〃 |
| 2028-05-29 | Memorial Day | 〃 |
| 2028-06-18 | Father's Day | 〃 |
| 2028-07-04 | Independence Day | 〃 |
| 2028-09-04 | Labor Day | 〃 |

Moving holidays were checked against the calendar (Thanksgiving = fourth
Thursday of November, Easter by the Gregorian computus, and so on).
Extend the table a year ahead each September; last extended 2026-09-25,
through Labor Day 2028. A repeat holiday should not repeat an app: build
on the kept one, or pick a new job the holiday creates.

## The landing page

`public/` — no model calls, no account. Cards per drop with Try / 🔥 Keep /
💀 Kill, a private "tell Erik" note, a mystery card with a countdown to the
next drop (09:00 UTC daily, matching the routine), and "how the lab
works". Votes are one per browser (an opaque `lab_vid` cookie; no IP, no user
agent), changeable and withdrawable. A card shows how many voted but not
which way until this browser has voted on it (see "Crowd reveal" below).
Notes are stored in `lab_notes` and **never displayed** — nothing to moderate, nothing to deface. Read them in
Firestore.

**Order (Erik, 2026-09-27):** the drops show newest first, with a sort bar
above them: Newest, Oldest, Most votes, Not voted yet, A–Z. The choice is kept
in this browser (`localStorage` `lab-sort`, wrapped in try/catch), never sent
anywhere. The **drop number is the app's place in `lab.js`**, not its place on
screen, so a sort never renumbers anything; two drops on one date order by
that number. Retired apps sit at the end of every order and the "Classified"
next-drop card is always last. A vote redraws its card in place and does not
re-sort, so Most votes does not jump under your thumb.

## The leaderboard

`GET /api/lab/leaderboard` — Keep/Kill standings from `lab_votes`: per app
`slug`, `name`, `emoji`, both colours, `drop` number, `dropped`, `status`,
`live`, **`votes` (the total) and `rank`**, plus `leader`. **No split**: no
`keep`, `kill` or `keepPct` — see "No split in public" below. Ranked on the
lower bound of a 95% Wilson interval on the keep share, worked out on the
server and not sent (one keep does not outrank 9 of 10); a leader is named
only with 2+ votes and a strict lead, else `null`. Retired apps are left out.
Counts only: it never mints `lab_vid` (it reads nothing per visitor), CORS
for the apex and `www.` like `/api/lab`, 15 s in memory (a vote clears it)
and `max-age=15`. Read by the lab's own page (the Leaderboard section), the
main site's `/api/activity` (the home page's banner and "Live now" feed) and
the `/challenge` teaser's Leaderboard line. `standings()` is exported and
tested in `test/lab.js`. A daily drop needs no change here.

### No split in public (2026-09-27)

Erik reviewed the crowd reveal and chose to make "you see the split only
after you vote" real rather than a nudge: until then the leaderboard handed
every app's keep % to anyone, so the lab page hid a number the API published.
Now a keep % leaves the lab in exactly one place, `/api/lab`'s per-browser
`split` (voted on that app, 5+ votes). Every reader was changed with it:

- the lab's Leaderboard section takes the % from `data.apps[].split`, else
  "🔒 Vote to see" / "Split at 5";
- the main site's `/api/activity` (`lib/activity.js`) keeps `votes` and
  `rank` only, and drops any split a lab might still send; its leader line
  is "Glowup leads the Keep votes · 10 votes";
- the home banner's three cells say "**10** votes", the leader's with an
  outline and the heading "Glowup leads now" — the keep meter under each
  cell is gone;
- the `/challenge` teaser line reads "1. ✨ Glowup leads, **10** votes · 2.
  …". Its `FALLBACK` (drops, for when the lab is down) never had numbers.

What still leaks, and is accepted: the rank order plus vote counts, watched
over time, can say which way one new vote went (two apps with the same count
swap places). The order is the point of a leaderboard, and the brief kept it.

The daily routine's LinkedIn line ("the Keep/Kill leaders from `lab_votes`,
stated honestly") reads Firestore with the deploy token, not this API, so it
can still quote real numbers. Nothing in `scripts/` reads the leaderboard.

## Build stats: tokens, agents and time per app (2026-09-26)

Erik asked for "how many tokens input output on the challenge page and also
how many agents have run and time it's used". The truth source is the builder
agents' own transcripts; the page never estimates anything itself.

- **`build-stats.json`** (committed, here) — `{updated, apps: {<slug>: {in,
  cached, out, agents, agentMs, wallMs, exact, note}}, totals}`. `in` is fresh
  input + cache writes + cache reads; `cached` is the cache reads alone (null
  when an estimate has no split); `agentMs` sums each agent's active span (last
  minus first timestamp in its transcript); `wallMs` is first to last across
  the agents (shorter than `agentMs` for a workflow, whose agents overlap).
  **Apps only**: totals are the sum of the app rows, nothing else. If the lab's
  own setup or other non-app work is ever counted, it goes in as a clearly
  labelled row, not folded into an app.
- **Written only by `scripts/token-ledger.py --stats`**, idempotent (re-running
  a slug replaces its row and recomputes totals):
  - one agent: `python3 scripts/token-ledger.py --stats <slug> <agent.jsonl> --note "One builder agent."`
  - a workflow: `python3 scripts/token-ledger.py --stats <slug> --workflow <dir> --note "..."`
    (counts every `agent-*.jsonl` in it; `journal.jsonl` is not an agent)
  - no transcript: `--estimate --in 30e6 --out 200e3 --agents 1 --agent-min 45 --note "..."`,
    which marks the row `exact: false`; the page labels it "est.".
  `--dry-run` prints the row without writing. Builder transcripts are under
  `~/.claude/projects/<project>/<session>/subagents/` in the session that ran
  them, so the ledger has to run in that session, before it ends.
- **Served** on `GET /api/lab`: `build` on each app that has a row, and
  `buildTotals` (the sums, `apps`, `estimated`, `cachedShare` over the rows
  that know their split, `updated`). Read once at startup; missing or
  malformed, the fields are simply absent. `readBuildStats()` cleans every
  row (whole non-negative counts, `exact` only when `true`, no `<>` in notes).
  Tests: `test/build-stats.js`, which also runs the ledger on a fixture.
- **Drawn** on the lab page as "How it's built" (tokens in, tokens out,
  agents run, agent time, apps shipped, and one plain line on why most input
  is cached) plus a "Build" line on each card; and on the main site's
  `/challenge` teaser as one "Built so far" line in held space. Numbers count
  up once, only without reduced motion.
- Spar and Snapquote were built in a session whose transcripts are gone: they
  are estimates at the midpoint of TOKENS.md's range, 45 minutes each.

## The teaser on the main site

`site/challenge.html` (www…/challenge) is a **teaser**, not a second lab:
two lines of story, the latest drop, the locked next one with its countdown,
and the earlier drops as blurred emoji behind "N more waiting in the lab".
It reads `/api/lab` live, so a daily drop needs no change there; its
`FALLBACK` only matters when the lab is unreachable. Full cards, votes and
"how it works" stay here. Erik asked for it that way on 2026-09-24 because
the two pages were showing the same thing twice.

**Transcripts can under-report output** (found 2026-09-26): newer builder
transcripts record only the start of each streamed reply, so a whole build can
read ~5K tokens out. If a ledger run shows under ~20K out, record the exact
input and an estimated output with `--estimate ... --note`, as Tally's row does.

## Graduating an app

When Erik picks a keeper:
1. `git mv challenge/apps/<slug> apps/<slug>` and give it a normal `apps.json`
   entry; drop its `lab.js` status to `graduated` with `home:` its new URL.
   Its `index.html` still carries the lab's `<!-- lab:og -->` block, pointing
   at `challenge.…/og/<slug>.png` and `og:url` on the lab: rewrite it for the
   new address (the PNG can move with it), then `npm run og` here to redraw
   the landing card without it.
2. Erik runs `scripts/new-app-accounts.sh <slug>` in Cloud Shell.
3. `gcpdeploy create <slug> --env PASSKEY_RP_ID=strongtechnicalconsulting.com --domain <slug>.strongtechnicalconsulting.com`.
4. Copy its `<slug>_*` collections from `challenge` into its own database
   without the prefix, if its trial data is worth keeping.
5. Flight and Inside Joke are also iPhone apps (`mobile/README.md`). If one
   graduates, move its entry out of the lab's
   `/.well-known/apple-app-site-association` (`IOS_APPS` in `server.js`) to
   the new host, and change its `server.url` and entitlements in
   `mobile/scripts/generate.mjs`, regenerate, and ship a new build.

## Crowd reveal, voting streaks and badges (2026-09-26)

Erik asked for features that "draw users in, feature rich, and make it fun".
No model call in any of it, and nothing scheduled: all of it is worked out
inside the request.

**The crowd reveal.** Before this browser votes on an app, `/api/lab` sends
`votes: {total}` and `split: null` for it: how many voted, never which way,
so the crowd cannot steer the first tap. After a vote, and only with
`MIN_SPLIT` (5) votes behind it, `split: {keep, kill, keepPct}`; the card
grows the bar in and counts up "You sided with 71% (Keep)", tags a side
under 35% "Contrarian" and 80%+ "With the crowd", and says "You've voted on 6
of 9 drops · Next: Booth →" (the newest drop you have not voted on). Under 5
it says so ("Only 3 votes so far — the split shows at 5"). Withdrawing hides
it again. `reveal()` is the one rule; the vote route answers with it.

- **The public leaderboard carries no split** (since 2026-09-27; it did on
  the first day, which made this a nudge — see "No split in public"). The
  lab's own Leaderboard section draws the rank and votes for every app, and
  the % and bar only from this browser's own `split` ("🔒 Vote to see",
  "Split at 5" otherwise).

**The streak.** Consecutive **drop days** on which this browser voted on
that day's drop *while it was the newest*. "Newest" comes from the registry
the running instance was deployed with, not the clock: a drop is today's
from the deploy that ships it to the deploy that ships the next, in every
time zone. So a vote on an older drop is a vote but not a streak day,
yesterday's drop cannot be voted on today to backfill a miss, and a day the
routine missed is not a drop day at all, so it neither counts nor breaks
anyone's streak. A streak is `pending` (alive) until the next drop lands
without a vote; missing one drop day resets it. `streakOf()` does the sums.

- **Stored** in `lab_streaks/<lab_vid>`: `{days: [drop dates credited],
  earned: [badge ids]}` — array-unioned (`store.merge`, `arrayUnion`), so two
  votes at once cannot drop a day, and written only when something is new
  (most votes write nothing there). No time, no IP, no device. The streak
  is computed on read from `days` against `dropDays()`.
- **Badges** (`BADGES`): First vote; 3-day and 7-day streak (from the best
  run, so they stay once earned); Full week (a vote on every drop dropped in
  the seven days ending at the newest drop — at least two of them; the vote
  route reads only those `lab_voters` docs, never every drop the lab has
  had); Contrarian (sided with under 35% of 5+ votes at the moment you
  voted). Earned badges stay when the vote is withdrawn. Only the known set
  is ever returned, whatever a record holds. The vote route returns
  `newBadges` and the card says "Badge unlocked" under the reveal — not a
  toast, which sat on top of the split on a phone.
- `/api/lab` adds `me: {streak, best, pending, voted, of, today, badges}` for
  a request that carries (or is minted) a `lab_vid`; the main site's
  cross-origin read carries no cookie and gets no `me`. The page draws it as
  the strip under the hero: streak and what to do next ("Vote on today's
  drop, Tally, to make it 4 →"), N of M drops voted, and all five badges,
  locked ones greyed with their hint on tap.
- **Per browser, not per account.** The lab's own page has no sign-in: the
  shared account is mounted inside each app (`/<slug>/api/auth`), not by the
  host, so a streak cannot follow someone to another device. Doing that would
  mean the host reading the identity session (and `identity-session-secret`,
  which `challenge-run@` already holds) and folding the `lab_vid` record into
  a uid-keyed one on sign-in — the football app's `adoptAnon` shape. Not done.

Tests: `test/engage.js` (reveal hidden before a vote and under 5, shown at
5; the streak across simulated drop deploys, a missed day resetting it, no
backfill, the day with no drop; every badge; what is stored; hostile input).

## Link previews: og:image cards (2026-09-26)

The daily LinkedIn and Typefully posts link to the lab and to each app, and
those links unfolded into nothing. Now every live app and the landing page
carry `og:*` and `twitter:*` (`summary_large_image`) tags with **absolute**
`https://challenge.strongtechnicalconsulting.com/...` URLs, and a 1200x630
card each.

- **Static, drawn at build time** by `scripts/og.js` (`npm run og`), not in
  the runtime image. It uses the football app's renderer (`@resvg/resvg-js`
  2.6.2, SVG -> PNG) with its Inter TTFs copied to `scripts/fonts/` (SIL OFL,
  licence beside them). Both it and the emoji set are **devDependencies**,
  and the Dockerfile installs `--omit=dev`; `.dockerignore` leaves out
  `scripts/` and `og-manifest.json`. A card only changes when `lab.js` does,
  which only changes with a deploy, so a live renderer would buy nothing but
  a native binary in the image. The live keep % is deliberately not on the
  card: unfurlers cache for days, so it would be wrong by the time it was
  seen.
- **The emoji.** Inter's Latin subset has none, and resvg does not draw a
  colour emoji font (tried: NotoColorEmoji draws blank). Each emoji is drawn
  from Noto Emoji's own SVGs (`@iconify-json/noto`, Apache-2.0), looked up by
  code point, ids prefixed so two emoji on one card cannot share a gradient.
  An emoji the set lacks becomes the app's initial on a white tile. The card
  is the app's two colours, darkened only as far as white text needs for
  4.5:1 (Spar's orange and Snapquote's teal needed it; the test checks every
  app), its name, tagline, drop number and address.
- **The landing card** (`public/og/lab.png`) shows how many apps have
  shipped and the newest nine as tiles, the newest ringed "NEW", so it is
  redrawn by every drop.
- **Tags** live between `<!-- lab:og ... -->` and `<!-- /lab:og -->` in
  `public/index.html` and each `apps/<slug>/public/index.html`, written by the
  script (never by hand), just before `</head>`. Every value is escaped.
  `og:image` carries `?v=<first 10 hex of the PNG's sha256>`, so a redrawn
  card is a new URL and LinkedIn's cache cannot serve the old one. Served
  from `public/og/` by the host's static handler, so no app may be called
  `og` (tested).
- **`og-manifest.json`** records, per card, a hash of the `lab.js` fields it
  was drawn from and the PNG's version. `test/og.js` recomputes both and
  compares every tag block byte for byte, so a new app without a card, an
  edited tagline without a redraw, or a hand-edited tag fails `npm test`.
  `npm run og -- --check` says what is stale without writing;
  `npm run og -- --redraw` redraws every card (after changing the drawing
  code, which the input hash does not cover).
- Unfurlers read the landing's and the apps' own HTML. An app's share pages
  (Booth's `s/<token>`) reuse its `index.html`, so they show the app's card —
  never the shared record.

## Deploy

- Service `challenge`, database `challenge`, runtime account `challenge-run@`
  (datastore.user on `challenge` + `identity`; secrets `anthropic-api-key`,
  `identity-session-secret`).
- **Live since 2026-09-24** at `https://challenge-u4h4ftn3fa-uc.a.run.app`,
  and at `https://challenge.strongtechnicalconsulting.com` since its CNAME
  went in on 2026-09-25.
- First deploy (done):
  `gcpdeploy create challenge --env PASSKEY_RP_ID=strongtechnicalconsulting.com --domain challenge.strongtechnicalconsulting.com`
  then DNS at the registrar: `CNAME challenge -> ghs.googlehosted.com`
  (done 2026-09-25).
- Every deploy after: `gcpdeploy ship challenge`.
- Billed per request (`cpuIdle: true`) like everything else — never keep
  working after a response.

## Security fixes (2026-09-27)

A review of the lab found these; all fixed the same day.

- **Vote stuffing.** `POST /api/lab/:slug/vote` minted a `lab_vid` for any
  cookieless request, so a curl loop added a vote (and a `lab_voters` and a
  `lab_streaks` write) per request. A vote now needs an id the request already
  carries (the page's own `GET /api/lab` mints it before anything can be
  tapped; a bare request is a 400 "Reload the page to vote."), and an address
  may bring at most `LIMITS.votersPerIp` (20) different ids to the vote route
  an hour, 2,000 across the instance; the rest are 429 and count nothing.
  IPv6 counts by its /64. Withdrawing a vote never cast writes nothing. Notes
  need an id too and are capped at 10 an hour per address and 300 across the
  instance. In memory, per instance, like Receipt's `newVotersPerIp`. The id
  is still random rather than signed, so this slows stuffing rather than
  stopping it: someone with many addresses can still vote many times.
- **A script CSP on the host and every app** (`script-src 'self';
  object-src 'none'; base-uri 'self'` plus `frame-ancestors`). All the apps
  share this origin, so one app's injection would run as every app. No page
  has an inline `<script>` or `on*=` handler, which `test/lab.js` checks on
  every `index.html`; every page was rendered in headless Chromium at 390 and
  1280 px with no CSP violation. **A new app must not add inline script.**
- **Teammates' uids.** Booth and Pop Quiz sent members each other's uids
  (base64url of the email). Now a per-event (per-team) opaque HMAC id, `mine`
  and `you`; see those apps' notes.
- **Spar's public names.** New players are "Player 4821" until they pick a
  name; an old handle made from the email is shown neutral on public surfaces.
- **Snapquote** reads its 9 MB draft body only after the sign-in and budget
  checks; **Spar** team codes have Booth's wrong-guess limiter; **Spar,
  Snapquote, Chaser, Glowup, Rave, Booth and Pop Quiz** no longer pass a
  model provider's error to the page (Receipt's `fail()`).

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
