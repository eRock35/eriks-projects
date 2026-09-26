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
2. Add its entry to `lab.js` (name, emoji, two colours, drop date, tagline,
   blurb, four features, audience, `status: 'testing'`).
3. Record what it cost to build (see "Build stats" below):
   `python3 scripts/token-ledger.py --stats <slug> <builder agent.jsonl>`
   (or `--workflow <dir>` for a workflow build), then add its row to
   `TOKENS.md`. Both are committed; the lab serves the JSON.
4. `npm test` here runs the host tests, the build-stats tests and every app's
   suite.
5. Commit, push, `gcpdeploy ship challenge`.

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
agent), changeable and withdrawable. Notes are stored in `lab_notes` and
**never displayed** — nothing to moderate, nothing to deface. Read them in
Firestore.

## The leaderboard

`GET /api/lab/leaderboard` — Keep/Kill standings from `lab_votes`: per app
`keep`, `kill`, `votes`, `keepPct` (null with no votes), `rank`, `drop`
number, plus `leader`. Ranked on the lower bound of a 95% Wilson interval on
the keep share (one keep does not outrank 9 of 10); a leader is named only
with 2+ votes and a strict lead, else `null`. Retired apps are left out.
Counts only: it never mints `lab_vid` (it reads nothing per visitor), CORS
for the apex and `www.` like `/api/lab`, 15 s in memory (a vote clears it)
and `max-age=15`. Read by the lab's own page (the Leaderboard section), the
main site's `/api/activity` (the home page's banner and "Live now" feed) and
the `/challenge` teaser's Leaderboard line. `standings()` is exported and
tested in `test/lab.js`. A daily drop needs no change here.

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
2. Erik runs `scripts/new-app-accounts.sh <slug>` in Cloud Shell.
3. `gcpdeploy create <slug> --env PASSKEY_RP_ID=strongtechnicalconsulting.com --domain <slug>.strongtechnicalconsulting.com`.
4. Copy its `<slug>_*` collections from `challenge` into its own database
   without the prefix, if its trial data is worth keeping.

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

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
