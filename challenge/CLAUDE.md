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
3. `npm test` here runs the host tests and every app's suite.
4. Commit, push, `gcpdeploy ship challenge`.

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

Moving holidays were checked against the calendar (Thanksgiving = fourth
Thursday of November, and so on). Extend the table a year ahead each
September.

## The landing page

`public/` — no model calls, no account. Cards per drop with Try / 🔥 Keep /
💀 Kill, a private "tell Erik" note, a mystery card with a countdown to the
next drop (09:00 UTC daily, matching the routine), and "how the lab
works". Votes are one per browser (an opaque `lab_vid` cookie; no IP, no user
agent), changeable and withdrawable. Notes are stored in `lab_notes` and
**never displayed** — nothing to moderate, nothing to deface. Read them in
Firestore.

## The teaser on the main site

`site/challenge.html` (www…/challenge) is a **teaser**, not a second lab:
two lines of story, the latest drop, the locked next one with its countdown,
and the earlier drops as blurred emoji behind "N more waiting in the lab".
It reads `/api/lab` live, so a daily drop needs no change there; its
`FALLBACK` only matters when the lab is unreachable. Full cards, votes and
"how it works" stay here. Erik asked for it that way on 2026-09-24 because
the two pages were showing the same thing twice.

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
  domain mapping created; the site answers on the subdomain once the DNS
  record below exists.
- First deploy (done):
  `gcpdeploy create challenge --env PASSKEY_RP_ID=strongtechnicalconsulting.com --domain challenge.strongtechnicalconsulting.com`
  then DNS at the registrar: `CNAME challenge -> ghs.googlehosted.com`.
- Every deploy after: `gcpdeploy ship challenge`.
- Billed per request (`cpuIdle: true`) like everything else — never keep
  working after a response.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
