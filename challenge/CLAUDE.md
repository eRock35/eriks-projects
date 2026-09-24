# For Claude: the Challenge Lab

`challenge.strongtechnicalconsulting.com` — where Erik's "new app every other
day" experiments live while they are being tested. Erik asked for it on
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

## Adding an app (what the every-other-day routine does)

1. Build it in `challenge/apps/<slug>/` following Spar (`apps/spar/CLAUDE.md`):
   exports `{ app }`, listens only when run directly, BASE-relative URLs,
   `<SLUG>_MEMORY` / `<SLUG>_FAKE_AI` / `<SLUG>_COLLECTION_PREFIX`.
2. Add its entry to `lab.js` (name, emoji, two colours, drop date, tagline,
   blurb, four features, audience, `status: 'testing'`).
3. `npm test` here runs the host tests and every app's suite.
4. Commit, push, `gcpdeploy ship challenge`.

## The landing page

`public/` — no model calls, no account. Cards per drop with Try / 🔥 Keep /
💀 Kill, a private "tell Erik" note, a mystery card with a countdown to the
next drop (09:00 UTC on even days, matching the routine), and "how the lab
works". Votes are one per browser (an opaque `lab_vid` cookie; no IP, no user
agent), changeable and withdrawable. Notes are stored in `lab_notes` and
**never displayed** — nothing to moderate, nothing to deface. Read them in
Firestore.

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
- First deploy:
  `gcpdeploy create challenge --env PASSKEY_RP_ID=strongtechnicalconsulting.com --domain challenge.strongtechnicalconsulting.com`
  then DNS at the registrar: `CNAME challenge -> ghs.googlehosted.com`.
- Every deploy after: `gcpdeploy ship challenge`.
- Billed per request (`cpuIdle: true`) like everything else — never keep
  working after a response.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
