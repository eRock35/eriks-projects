# Deploy runbook

Operational reference for every app running under `strongtechnicalconsulting.com`.
Written for whoever is acting as the deploy agent — a session container is
ephemeral, so nothing here should live only in a conversation.

**This file is in a public repo.** It names infrastructure (project, services,
secret *names*, buckets) but never secret *values*. Keep it that way.

## Use the tool

`.claude/skills/deploy/` holds a `deploy` skill and a `gcpdeploy` script that
automate everything below. Prefer them:

```
./.claude/skills/deploy/gcpdeploy status
./.claude/skills/deploy/gcpdeploy ship <football|trip|vacation>
./.claude/skills/deploy/gcpdeploy verify <app>
./.claude/skills/deploy/gcpdeploy page
```

The rest of this file is the reference behind the tool — read it when the
script can't do what you need, or when you need the raw REST shapes.

## The constraint that shapes everything

There is **no `gcloud` CLI** — `sdk.cloud.google.com` is blocked by the
container's egress policy — and **no local Docker**. Every operation is a direct
REST call to `*.googleapis.com`, authenticated with an OAuth2 token minted from
a service account key by a Python venv.

Do not try to route around the egress block. A `403` or `407` from the proxy is
a policy decision, not a transient failure.

The same proxy blocks `*.run.app` and the custom domains, so **you cannot curl
the live apps from the container**. Verify deploys through GCP's own APIs
(revision conditions, Scheduler run status, Firestore reads) and ask Erik to
confirm in a browser.

## Bootstrap

```bash
SP=<scratchpad>/gcp     # venv + sa-key.json live here
$SP/venv/bin/python -c "
from google.oauth2 import service_account
import google.auth.transport.requests
c = service_account.Credentials.from_service_account_file(
    '$SP/sa-key.json', scopes=['https://www.googleapis.com/auth/cloud-platform'])
c.refresh(google.auth.transport.requests.Request())
open('$SP/token.txt','w').write(c.token)
"
```

Tokens last an hour — re-mint rather than debugging a stale-token 401.

**The service account key does not survive a new container.** It is uploaded per
session. If `sa-key.json` is missing, ask Erik to re-upload it; don't improvise.
Erik has asked about storing it as a persistent environment variable — the
environment's plain "Environment variables" box is **unencrypted**, so that
trade is his call to make knowingly, not a convenience to adopt quietly.

Deployer service account: `cover-sheet-deployer@metal-celerity-236019.iam.gserviceaccount.com`
(named for a since-renamed app; the name is historical, not a mistake).

## Shared facts

- GCP project `metal-celerity-236019`, region `us-central1`
- Artifact Registry repo `erik-projects`
- Cloud Build staging bucket `metal-celerity-236019-cb-source`
- Landing page bucket `www.strongtechnicalconsulting.com` (static website hosting)
- Shared secret: `anthropic-api-key`

**Firestore: never use `(default)`.** On this project it is a legacy
Datastore-mode database tied to App Engine. Every app gets its own *named*
Native-mode database.

## Deploy pipeline (Node apps)

1. Tar the repo, excluding `.git` and `node_modules`.
2. Upload to the staging bucket via the Storage JSON upload endpoint.
3. `POST cloudbuild.googleapis.com/v1/projects/$P/locations/us-central1/builds`
   with a `storageSource`, a `docker build` step, and
   `options.logging: CLOUD_LOGGING_ONLY`.
4. Poll the build until it leaves `QUEUED`/`WORKING`.
5. Read `results.images[0].digest` and **deploy that digest, not `:latest`.**
   A floating tag does not produce a new revision — this has bitten us.
6. `POST`/`PATCH` the Cloud Run Admin **v2** service, then poll
   `terminalCondition` until `CONDITION_SUCCEEDED`.
7. For a public-browse app, `setIamPolicy` granting `roles/run.invoker` to
   `allUsers`.

Cloud Run service names are immutable. Renaming means create-new + delete-old.

A revision reaching Ready is real evidence: Cloud Run fails the revision if a
referenced secret can't be read, so Ready means secrets mounted and the
container bound its port.

## Creating a service (first deploy only)

`gcpdeploy ship` updates an existing service; it cannot create one. For a new
app, build first, then POST the service once:

```
POST run.googleapis.com/v2/projects/$P/locations/us-central1/services?serviceId=<name>
```

with `template.containers[0].image` pinned to the digest, then grant
`roles/run.invoker` to `allUsers` via `:setIamPolicy` if it's public. After
that, `gcpdeploy ship` handles every later deploy.

Two things Cloud Run will reject or overcharge for:

- **Memory under 512Mi requires `resources.cpuIdle: true`.** Without it the
  service defaults to CPU always-allocated, which both rejects 256Mi and bills
  for idle time. `cpuIdle: true` bills CPU only while a request is in flight.
- **Leave `minInstanceCount` at 0.** Any other value is a standing charge. For
  the landing page that is the entire reason it is on Cloud Run rather than
  behind a load balancer.

## Verifying without HTTP access

The strongest available end-to-end check is to force-run the app's Cloud
Scheduler job and then read the Firestore doc that route writes:

```bash
POST cloudscheduler.googleapis.com/v1/.../jobs/<job>:run
# then re-read the job: empty "status" {} plus a fresh lastAttemptTime == success
```

An empty `status` means the app returned 2xx — which proves Cloud Run booted,
the cron secret matched, and the handler reached Firestore.

A Scheduler job that has never run shows `code: -1`. That is the *never-run
initial state*, not a failure.

## The apps

| App | Cloud Run | Firestore DB | Public URL |
|---|---|---|---|
| College Football | `college-football-app` | `college-football-app` | `footballapp.strongtechnicalconsulting.com` |
| Hopscotch (beer) | `hopscotch` | `hopscotch` | `beer.strongtechnicalconsulting.com` |
| Trip Planner | `trip-planner` | `trip-planner` | `trip-planner-…-uc.a.run.app` |
| Santa Rosa Beach Trip | `santa-rosa-beach-trip` | `santa-rosa-beach-trip` | *URL not written down — see below* |
| Landing page + writing | `landing-page` | `eriks-projects` | `strongtechnicalconsulting.com` and `www.` |
| Friction (signal board) | `friction` | `friction` | `friction.strongtechnicalconsulting.com` |
| DataViz (animated charts) | `dataviz` | `dataviz` | `dataviz.strongtechnicalconsulting.com` |

Per-app secrets are deliberately **not** shared. The football app's login is the
kind of thing Erik might hand to a friend so they can run research; that password
must not also open the trip apps.

- Football: `site-login-username`, `site-login-password`, `cfb-session-secret`, `cron-secret`
- Trip Planner: `trip-planner-login-username`, `-login-password`, `-cron-secret`, `-session-secret`
- Santa Rosa: `vacation-login-username`, `vacation-login-password`, `vacation-session-secret`
- Landing page: `landing-session-secret`, `landing-admin-password`, `resend-api-key`
- Friction: `friction-app-password`, `friction-session-secret`, `friction-cron-secret`
- DataViz: `dataviz-session-secret`
- Billing, domain-wide and NOT DataViz's own: `stripe-secret-key`,
  `stripe-webhook-secret`, `stripe-member-price`. Checkout is served from
  DataViz because that is the service holding the keys and the verified
  webhook, but what it sells is an account-level membership that spends in
  every app — see "Billing" below. Renamed off the `dataviz-` prefix on
  2026-09-21 for exactly that reason.

Don't write the Santa Rosa app's literal `*.run.app` URL into any public file.
See **Settled decisions**.

### Why two apps have no custom domain

A Cloud Run domain mapping provisions a certificate for that exact hostname,
which publishes it to public **Certificate Transparency logs** that bots scrape.
The default `*.run.app` URL rides Google's wildcard cert, so the service name
never appears there.

`santa-rosa-beach-trip` holds two young kids' details, exact travel dates, and
rental confirmation numbers. The quieter URL beat the nicer one. That trade has
since been revisited — see **Settled decisions**. The app keeps its `*.run.app`
URL; don't add a domain mapping for it.

## Which model each tier runs on

`identity.planFor(user, { free, paid })` decides, in one place, and hands back
**both** the model and the web-search tool that model accepts. Paid means the
owner, a Pro subscription, or a user on their own API key — anyone
`budgetFor()` calls unlimited. Everyone else, including anonymous visitors,
gets the free model.

| App | free | paid | why |
|---|---|---|---|
| trip-planner chat + watch checks | Haiku 4.5 | Sonnet 5 | chat holds up fine on Haiku |
| football research | Haiku 4.5 | Sonnet 5 | same |
| dataviz `/api/viz` | Haiku 4.5 | Opus 5 | **reachable with no account** — a sample with no baked spec falls through to the model |
| friction scan | — | Opus 5 | not tiered: scoring *is* the product, and its own CLAUDE.md says not to economise here |
| santa-rosa chat | — | Sonnet 5 | one family, no tiers, no identity module |
| football overnight batch | — | Sonnet 5 | Erik's own cost, and already 50% off through the Batch API |

Prices per million tokens: Haiku 4.5 **$1/$5**, Sonnet 5 **$2/$10**, Opus 5
**$5/$25**. A searching answer measured 11,094 in / 457 out — about 1.3¢ on
Haiku against 2.7¢ on Sonnet, so the $2 allowance buys roughly twice as much.

**Never write a `web_search` tool type at a call site.** Measured against the
live API: Haiku 4.5 returns **400** on `web_search_20260209` ("does not
support programmatic tool calling"); it needs the basic
`web_search_20250305`. The newer one needs Opus 4.6+ or Sonnet 4.6+. Model
and tool have to move together, which is why `planFor` returns the pair and
why downgrading a model without it would 400 every free-tier chat.

`planFor` is a **module** export, not a method on the object `create()`
returns — `identityLib.planFor(...)`, not `identity.planFor(...)`. The test
suite caught that one.

## Public previews, and what frames what

Every app can be looked at without an account; only the things that cost
money or belong to someone need a sign-in. What each shows signed-out:

| App | Signed-out | Gated |
|---|---|---|
| football | the whole board (`/api/games`, `/api/asks`, `/api/changelog` are open) | research, the slip |
| trip-planner | **the example trip** at `#/trip/demo` — itinerary, watches with history, a short chat; served from `demo.js`, not Firestore, read-only for everyone (`loadOwnedTrip` 403s writes to it) | your own trips |
| dataviz | the samples | your own data, saving |
| friction | **`/preview`** — the strongest problems, title/summary/who/score/recurrence only. Never the evidence quotes (other people's words, under their sources' licences), never status or notes (Erik's decisions). `/api/public/board`, cached 10 min | the board, lenses, runs |
| santa-rosa | nothing, deliberately | everything |

The landing page's **Projects** section frames those preview URLs in a
swipeable strip of phone-shaped frames. Each frame loads only when it
scrolls near (five cold starts on page load would be silly), the app inside
renders at 390px and is scaled to fit, and a transparent layer over each
keeps swipes on the strip and turns a tap into "open the app".

**Tour mode.** Every framed URL carries `?tour=1`, and the app then runs
a scripted loop on itself so the frame looks used: trip-planner reads the
example chat, types a question and shows a canned answer arrive, opens a
day, glances at the watches; football scrolls the card, opens a "why",
visits the board; DataViz plays one free sample after another; Friction reads
down the preview. `shared/tour.js` is the helper (copied into each app's
`public/`; Friction serves it before the gate). Three rules it keeps:
nothing it does costs money - chat answers are canned and drawn into the
DOM, DataViz taps only samples marked `free` by `/api/datasets`; it runs
only with `?tour=1` and never under reduced motion; a failing step restarts
the loop rather than leaving the page half-animated.

**`Content-Security-Policy: frame-ancestors`** on football, trip-planner,
dataviz and friction allows `'self'` plus `strongtechnicalconsulting.com`
and `www.`. Nothing set X-Frame-Options before, so anyone could frame these
apps; this narrows it to the landing page. Hopscotch's build cannot run in
the sandbox so it has no such header yet — it frames because nothing forbids
it.

**Friction's scan is daily** (06:15 ET) as of 2026-09-21. Four-hourly on
Opus measured ~$0.83/day.

## Bring your own key

A user can run every app on their own Anthropic key instead of the shared $2.
`shared/byok.js` stores it; `identity` exposes it.

- **Saving** goes through `POST /api/auth/byok`, which **validates the key
  against Anthropic before storing it** (a listing call, no tokens) — a typo
  is caught there rather than as a failed answer an hour later.
- **It is never readable again.** `/me` returns `{supported, present, last4,
  addedAt}` and nothing else, and the save response does not echo the key
  back either.
- **Encryption:** AES-256-GCM under `BYOK_ENCRYPTION_KEY` (Secret Manager
  secret `byok-encryption-key`, 32 bytes base64), mounted on every service.
  The uid is the GCM additional-authenticated-data, so a ciphertext copied
  into another account's record fails to decrypt rather than quietly working.
  Ciphertexts are tagged `v1.` so a future scheme can be written alongside.
- **Cloud KMS is the better answer and is not done yet.** The deployer service
  account has `cloudkms.keyRings.create` denied — the same permission gap as
  `cloudscheduler.jobs.create` and the domain mapping. The KMS **API is now
  enabled** on the project, so the upgrade is: Erik creates a keyring + key in
  the console, grants the runtime account
  `roles/cloudkms.cryptoKeyEncrypterDecrypter`, and a `v2.` branch goes into
  `byok.js`. Existing `v1.` rows keep working — no migration.
- **Billing:** `budgetFor()` returns `reason: 'byok'` and unlimited, so they
  skip the allowance and get the **paid** model tier. Usage rows are still
  written with `byok: true` so the dashboard shows what ran; the `spentUsd`
  bump is skipped, because nobody is being charged.
- **Using it:** apps build one client at startup with the service key.
  `identity.clientFor(user, fallback, make)` returns that client, or a metered
  per-key one when the user has a key on file. It caches by key (cleared on
  removal, so a removed key stops working immediately) and identity never
  imports the SDK — the app passes `make`.
- **The UI** lives in DataViz's account sheet next to the top-ups, reachable
  from anywhere by `?key=1` (`?topup=1` opens the same sheet). One place to
  spend money or supply a key, same reasoning as checkout. A shared
  `/account` page on the landing site is the better eventual home.
- **Anthropic keys only.** These apps lean on the server-side `web_search`
  tool and `pause_turn`; accepting an OpenAI or Gemini key would mean an
  adapter layer and silently worse results for exactly the users who brought
  one.

## Billing (Stripe)

Live account `acct_1UHo8nFbShmvZtSf` ("Erik - Consulting"), **live mode**.
There is exactly one thing to subscribe to:

- Product `prod_VIn0vs6b1CRsxS`, price `price_1UIBQdFbShmvZtSffjKYqbOV` —
  **the all-apps membership, $5.00/month**, recurring, `metadata.kind =
  membership`.
- Webhook `we_1UIBRBFbShmvZtSfLdov6BsT`.
- Top-ups are one-off `mode: payment` sessions built at call time from
  `stripe.TOP_UPS`, so they have no stored Price.

**There is no Pro plan.** The $9/month "DataViz Pro" subscription is retired:
its two live prices (`price_1UICFIFbShmvZtSfI70tk5FS`,
`price_1UIARYFbShmvZtSf3cjYq6t6`) and both products (`prod_VInrZHvUI8X54n`,
`prod_VIPZP6pNaEXud4`) are archived in Stripe, and it never sold a single
subscription. Two products where one is a strict subset of the other only
asked people to make a decision that does not matter; the membership buys all
five apps, DataViz's own-data feature included. If you are tempted to bring a
second tier back, price it against what the calls actually cost rather than
against the first one.

The service mounts `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
`STRIPE_MEMBER_PRICE_ID` from Secret Manager. `STRIPE_PRICE_ID` — the old Pro
price — is read by nothing and should not be set on any service.

**Stripe has no API that issues a secret key** — it only exists in the
Dashboard, so getting one into Secret Manager is a manual step and always will
be. Nothing in this repo, and nothing in a commit, should ever contain one.

### Verifying it, given you cannot reach either side

This container cannot reach `api.stripe.com` (egress policy) and cannot reach
`*.run.app` (same), so neither the Stripe API nor the deployed app answers
from here. `GET /api/stripe/health` on the running service closes that gap:
signed in, it makes one read-only call to Stripe and reports whether each
setting is present (never its value) plus the price's amount, interval and
`livemode`.

`livemode` is the field to read. A test key with a live price — or the
reverse — is the failure a paying customer finds first, and it is invisible
from any config file.

### Rotating the key

Roll it in the Dashboard (Developers → API keys), then add the new value as a
**new version** of `stripe-secret-key`. The service mounts `latest`,
so it picks the new version up on the next revision — which means a deploy, or
any other patch to the service, not automatically. Disable the old version
only once `/api/stripe/health` reports `ok: true` again.

A key that has been pasted into a chat, a terminal transcript, a ticket or a
screenshot should be rolled on principle, even a test one.

## The admin surface

- **`/admin`** is the overview: access requests waiting on a decision, app
  health, spend, accounts, the audit log. Landing an admin panel on the blog
  editor buried the things that actually need attention behind a list of
  posts, so the editor moved.
- **`/admin/writing`** is the blog editor, linked from the overview's header
  and reachable by the chart icon in its own nav bar.
- **`/admin/insights`** 301s to `/admin`, so older links still land somewhere
  sensible.
- Everything under `/admin` answers **404** to a non-admin, not 403, so the
  surface is not advertised.

Ordering on the overview is deliberate: the two "something needs you" sections
(requests, then health) sit together, and the control that emails them comes
after the things it reports.

## The shared account

One email + password + passkey opens landing, football, friction, trip-planner
and dataviz. `shared/identity.js` owns the user record, the session cookie and
the passkey; copies live in each sibling repo - fix the shared one first, then
re-copy.

- Firestore database **`identity`** (Native mode, us-central1), separate from
  every app's own data so no app's database is a dependency of everyone's
  sign-in. Collections: `users`, `webauthn-credentials`, `events`, `usage`.
- Secret **`identity-session-secret`**, mounted as `IDENTITY_SESSION_SECRET`.
  **Every app must mount the same one** - that shared secret is what makes a
  session portable. A service missing it refuses to recognise any session at
  all and logs loudly, because an empty HMAC key would otherwise let anyone
  mint a session for any account.
- `IDENTITY_DATABASE_ID=identity` and `PASSKEY_RP_ID=strongtechnicalconsulting.com`
  on each service. The rpID is what makes ONE Face ID enrolment work on every
  subdomain.

### Migrate an app's users BEFORE switching its login over

Learned the hard way on 2026-09-20. trip-planner's login was moved to identity
while the `identity` database was empty, which locked out every existing
account for about fifteen minutes - including three people who had registered
that evening. The deploy reported success; nothing was broken except that
nobody could sign in.

Both systems derive `scryptSync(password, salt, 64)` and differ only in
encoding (trip-planner hex, identity base64), so the four accounts were
migrated losslessly by converting the hash - existing passwords kept working
and nobody had to reset anything. `createdBy: 'trip-planner'` and `migratedAt`
mark the migrated records.

The rule, for any app wired next: **count the live users first, migrate them,
and only then point the login at identity.** An app whose own login route is
shadowed by identity's is exactly as broken as a deleted password column, and
it looks fine from the deploy output. A dry run against the real database
beats a survey taken hours earlier - on this project the user count went from
1 to 4 in the time it took to write the integration.

### The shared budget

Every account gets **$2 of API credit**, spendable across every app - not $2
per app. Five separate allowances would be $10 and would let anyone who
exhausted one simply move to the next, which is the thing this exists to stop.

Denominated in dollars, not calls: one Opus request with a long document is
worth many Haiku ones, and a call-count budget prices them the same.

| Who | What they get |
|---|---|
| The owner (`admin: true`) | Never metered. It is his API key. |
| A Pro account | Never metered; the subscription covers it. |
| Everyone else | `$2 + toppedUpUsd − spentUsd` |
| Signed out | No personal allowance; each app's own gate decides. |

`spentUsd` is charged by `recordUsage` using Firestore's atomic increment -
a read-modify-write would lose charges whenever two apps billed the same
account at once. `identity.requireBudget` sits in front of every route that
spends and answers **402** with the numbers when the credit is gone.

Attribution is automatic: `identity.mount` runs each request inside an
AsyncLocalStorage context, and the metered client reads the current user from
it. That is what lets one client per process charge the right person without
threading a uid through every function that might call a model.

Spending is recorded AFTER a call, so the last one allowed can overshoot by
its own cost. Bounded, and reserving an estimate up front then reconciling is
a lot of machinery for a couple of cents.

### Buying more

DataViz hosts the checkout (it holds the Stripe keys and the verified
webhook), but what it sells is account-level: `$5 / $10 / $25`, one-off
`mode: 'payment'`, credited to the shared identity record.

**The webhook must tell a top-up from a subscription.** The existing
`checkout.session.completed` handler grants Pro; a credit purchase falling
through it would hand someone a subscription they did not buy. `metadata.kind
= 'credit'` is what keeps them apart - do not remove it.

The admin can also grant credit directly from the dashboard's account rows
(`POST /api/admin/credit`), for comping a friend or refunding a bad run.
Negative amounts are allowed so a mistake can be taken back.

### Identity is not authorization

The account says who you are. It never says what you may do - one account now
opens five apps, so "is signed in" cannot mean "may use this". Each app reads
its own key off the user's `access` map, and **absent means no**, so
registering on the public dataviz page does not open the private research
tool. Grant and revoke from the dashboard's account rows; that API is the only
writer.

| App | key | level | what it buys |
|---|---|---|---|
| Friction | `friction` | `member` | the whole app (it is gated end to end) |
| Football | `football` | `research` | the routes that spend Anthropic tokens |
| DataViz | `dataviz` | `pro` | Pro, without a Stripe subscription |
| Trip Planner | `trip-planner` | `member` | reserved; AI access is still its own `aiAccess` field |

### Two doors everywhere, on purpose

Every app kept its original way in - Friction's `APP_PASSWORD`, football's site
password and its own registration, the landing page's `ADMIN_PASSWORD`. A fault
in the shared service must not lock Erik out of the surfaces he would use to
diagnose it. Retire a second door only once the first has been used in anger.

### What did NOT change

- **The uid.** trip-planner and dataviz already derived `base64url(lowercased
  email)`, which is exactly what identity uses, so every trip and project
  stayed owned by the same person with no migration. Football keyed its slips
  by the raw address instead, so a slip read falls back to the old key once
  and the next save settles on the new one.
- **Each app's own records.** dataviz keeps billing (`plan`,
  `stripeCustomerId`), trip-planner keeps `aiAccess`/`isAdmin`, football keeps
  its allowlist. Identity holds none of it.
- **Santa Rosa.** Not on this system and cannot be added by accident - see
  the note in `shared/identity.js`.

### Football has no sign-in button for it, deliberately

The cookie is scoped to the parent domain, so signing in on any sibling app
means football already sees you on the next request. Its own two-tap WebAuthn
registration was the riskiest thing to rewrite for the least gain, so it was
left alone as the second door.

## Email notifications

`landing-notify` (Cloud Scheduler, every 15 minutes) POSTs
`/api/cron/notify` on this service. It emails the address in `ADMIN_EMAIL`
when something needs a person, and **sends nothing when there is nothing to
say** - a quiet day produces no mail at all.

What it reports:

| Thing | Source |
|---|---|
| New account | identity `events`, kind `register` |
| AI-access request | trip-planner `users` with `aiAccess: pending` |
| Password-reset request | trip-planner `users` with `resetRequestedAt` |
| Failed sign-in burst | identity `events`, 5+ failures against one address |

Deliberately NOT reported: Erik's own admin actions (he just did them) and
ordinary sign-ins, which would make the mail worthless within a week.

### Why a job and not an inline send

Sending from wherever the event happens would mean mounting `RESEND_API_KEY`
on all five services and putting a third-party HTTP call in the middle of a
user's sign-up - if Resend is slow, registration is slow. One job reading what
already happened keeps the key in one place and keeps mail off the request
path.

### The two deduplication shapes

Events already happened, so a timestamp watermark (`control/notify.lastEventAt`
in the identity database) is enough. An unanswered request persists until
acted on, so a timestamp would re-send it every tick forever; those are keyed
individually in `control/notify.notified` by the timestamp already reported -
which means a SECOND request from the same person does notify again.

**The watermark only advances after a successful send.** A Resend outage
delays notifications; it does not lose them.

### Checking it without spending a send

`GET /api/admin/notify/preview` reports what the next tick would say, and
neither sends nor advances the watermark. The dashboard's Notifications card
uses it, and has a button to send on demand.

Verified end to end on 2026-09-20 by setting a reset flag on Erik's own
record, watching `lastSubject` appear (it is written only after the send
returns), then clearing the flag and confirming the next run stayed quiet.

## Analytics

One GA4 property covers every app. They are all subdomains of one registrable
domain, so GA's cookie already spans them - a visitor moving from the landing
page to dataviz stays one session, with no cross-domain configuration. Each
app sends `app_name` on every event, so the single property can still be split
per app.

`shared/analytics.js` serves the loader at `/analytics.js` from each app's own
origin; every public page carries one `<script src="/analytics.js" async>`
tag. Copies live in the sibling repos (`college-football-app/analytics.js`,
`trip-planner/analytics.js`, `santa-rosa-beach-trip/analytics.js`,
`apps/*/lib/analytics.js`) - fix the shared one first, then re-copy.

**It is off unless `GA_MEASUREMENT_ID` is set on the service.** With no ID the
route serves an inert file and nothing reaches Google. That is deliberate:
local runs, browser tests and screenshots would otherwise fire real hits and
pollute the numbers before a single visitor arrived.

A measurement ID is **not a secret** - it ships in the page source of every
site that uses it. Plain env var; do not put it in Secret Manager.

### Two rules that are easy to break

- **Mount it before the login gate.** On `santa-rosa` and `friction` the whole
  app is gated. A gated `/analytics.js` is a 401 or a redirect to `/login`,
  which makes the sign-in page - the page every visitor actually sees - the
  one page that never measures. The same mistake was made once with the shared
  passkey client.
- **The admin pages stay untagged.** They are one person, and their paths
  describe this site's own private structure.

### Live configuration (2026-09-20)

Property `G-TTVSSER479`, set as `GA_MEASUREMENT_ID` on `landing-page`,
`college-football-app`, `trip-planner`, `friction` and `dataviz`.

**`santa-rosa-beach-trip` is deliberately NOT set** — Erik's explicit call; see
that repo's CLAUDE.md. `hopscotch` is not wired at all (its build is separate).

The ID appears here and in every page's source because a GA measurement ID is
public by design. It is not a credential and does not belong in Secret Manager.

### Turning it on

Set `GA_MEASUREMENT_ID=G-XXXXXXXXXX` on each service. It is an ordinary env
var, so it can be patched onto a service without shipping a new image - but it
does create a new revision. To turn analytics off everywhere, remove the var;
the route starts serving the inert file again within the hour (the configured
response is cached for 3600s, the inert one is `no-store`).

### Not yet wired

- **Hopscotch (`beer-app`)** builds through its own `cloudbuild.yaml` and is
  not deployable from here (see the note in `apps.json`), so it was left
  alone. Its page is `web/index.html`.
- **Tab views.** These are tab-based single-page apps: GA counts one
  `page_view` on load and never hears about the tabs a visitor actually used.
  `window.track('<name>')` is exposed for exactly this and is not called
  anywhere yet - wiring it into each app's tab switch is what turns "how many
  visits" into "what did they do".

## Domain mappings

The deployer service account **can** create these, since it was added as an
**Owner** of the `strongtechnicalconsulting.com` property in Google Search
Console (2026-09-20). Cloud Run checks whether the calling identity is a
verified owner of the domain; before that, only Erik's own account was, which
produced "Caller is not authorized to administer the domain". It is not a
user-vs-service-account restriction, as the football app's docs used to claim.

```
POST us-central1-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/$P/domainmappings
{"apiVersion":"domains.cloudrun.com/v1","kind":"DomainMapping",
 "metadata":{"name":"<host>","namespace":"<project>"},
 "spec":{"routeName":"<service>"}}
```

Use the **regional** endpoint. The global one lists mappings but 404s fetching
a single one — an easy half-hour lost.

Creating a mapping is inert until DNS points at Google, so it changes nothing
for visitors on its own, and it can be deleted. Adding records at the
registrar is Erik's step. Google returns the exact records in the mapping's
`status.resourceRecords`: an apex takes four A and four AAAA records, a
subdomain takes `CNAME <name> ghs.googlehosted.com.`

**Before mapping anything, re-read "Settled decisions".** One app must never
get a mapping.

## Scheduler jobs

| Job | Schedule (America/New_York) |
|---|---|
| `cfb-batch-submit` | `0 8,18 * * 2-5` |
| `cfb-batch-collect` | `30 * * * 2-6` |
| `cfb-saturday-live` | `0 9-23 * * 6` |
| `trip-planner-check-watches` | `0 * * * *` |
| `hopscotch-dispatch` | `0 8 * * 4` (America/Chicago) |
| `friction-scan` | `15 */4 * * *` |

Weekday football research runs through the **Anthropic Batch API** (50% cost,
up to 24h latency) and goes live hourly on Saturdays. Batch supports
`web_search_20260209`; this was verified with a real test batch, not assumed.

`friction-scan` fires every four hours rather than daily on purpose. It scans
the single stalest of six lenses per run, so six runs a day gives each lens a
daily cadence while keeping one invocation inside its request timeout. Do not
"simplify" it to one daily run that scans everything - that is 144 rate-limited
requests in one handler.

Friction is also the one app whose source lives in a **subdirectory** of
another repo (`eriks-projects/apps/friction`), because the installed GitHub App
cannot create repositories. `apps.json` handles this by setting `repo` to the
path; nothing else knows or cares.

## Known open items

- **Runtime service account is over-privileged.** All services run as the broad
  deployer account rather than scoped-down per-app identities. Fixing it needs
  `roles/iam.serviceAccountAdmin`, which the deployer lacks. Do not self-grant
  IAM — ask Erik.
- **Empty `cover-sheet` Firestore database (us-east4) still exists.** Deleting it
  was blocked by a safety classifier. Left in place; harmless but untidy.

## Settled decisions

Don't re-open these; they were decided deliberately.

### The Santa Rosa app's URL exposure — reviewed and accepted (2026-09-20)

The `*.run.app` hostname for that app is less private than originally intended.
Erik reviewed the specifics, was offered the alternatives (rename the service,
or add a custom domain since the original benefit was largely spent), and chose
to accept the current state. The app is gated behind a password and passkeys,
and that gate was always the real protection.

Full details are in `eRock35/santa-rosa-beach-trip`'s CLAUDE.md, which is
private and the right place for them. Don't restate them here.

Two rules still stand: **no custom domain mapping** for that app (a mapping
publishes the hostname to Certificate Transparency logs), and **no literal
URL in any public file**.

## Writing and the newsletter

`/writing` is a small blog with an email list, served by the same Cloud Run
service as the landing page. Posts are written from `/admin` on a phone, with
Claude available in the composer as a drafting partner.

### The shape of it

- **Posts** live in Firestore, not in the repo, so a post does not need a
  deploy. A draft's URL follows its title; publishing freezes the slug,
  because a live URL that moves is a broken link in someone's inbox.
- **Publishing and sending are separate actions.** Making a post live never
  mails anyone. Sending is a second, explicitly confirmed step. An email
  cannot be recalled, so it does not get to happen as a side effect.
- **Double opt-in.** A signup is `pending` until the address clicks the
  confirmation link. Only `confirmed` addresses are ever mailed. This protects
  the domain's sending reputation, which is the thing that is slow to repair.
- **One-click unsubscribe** on every send: a `List-Unsubscribe` header, a
  `List-Unsubscribe-Post` header, and an unauthenticated `POST /unsubscribe`.
  Gmail and Yahoo expect this from bulk senders. Do not put that route behind
  any gate.
- **Idempotent sends.** Each recipient is recorded in
  `posts_<slug>_recipients/<subscriberId>`. Pressing send again resumes and
  skips anyone already mailed, so a timeout mid-send is safe. One run mails at
  most `MAX_SEND_PER_RUN` (default 500).
- **Confirm and unsubscribe links are HMAC tokens**, not stored rows. They are
  purpose-scoped, so an unsubscribe link cannot be replayed as a confirmation.
  They are signed with `SESSION_SECRET`: rotating that secret invalidates every
  outstanding link and every admin session.
- **Claude is admin-only and capped** at `AI_DAILY_CALL_CAP` calls a day
  (default 100). It writes into the editor and never publishes or sends.

### What the service needs

Firestore: a **named** Native-mode database, `eriks-projects`, in
`us-central1`. Never `(default)` on this project.

One composite index is required, on `posts`:

```
posts: status ASC, publishedAt DESC
```

Without it the `/writing` index and the RSS feed return 500s. Everything else
is a single-field query and is auto-indexed.

Secret Manager (names only; values are not in this repo):

- `landing-session-secret` — HMAC key for admin sessions and email tokens
- `landing-admin-password` — the one password that opens `/admin`
- `resend-api-key` — the mail provider key

**All three exist as of 2026-09-20**, along with the database and index. The
session secret and the admin password were generated at setup; the admin
password was shown to Erik once and is not recorded anywhere in the clear.
Rotating `landing-session-secret` invalidates every admin session and every
outstanding confirm and unsubscribe link, so do it only deliberately.

Plain env vars on the Cloud Run service:

- `FIRESTORE_DATABASE_ID=eriks-projects`
- `GOOGLE_CLOUD_PROJECT`
- `SITE_ORIGIN=https://www.strongtechnicalconsulting.com` — used to build the
  confirm and unsubscribe links, so it must match the real hostname or people
  get links to the wrong place
- `NEWSLETTER_FROM` — currently `Erik Strong <Erik.Strong@strongtechnicalconsulting.com>`.
  Any address on the verified domain works here with no extra DNS, since
  Resend verifies the domain and not the local part. Note that verifying a
  domain for sending does not create a mailbox: if nothing receives at this
  address, replies from readers bounce.
- `NEWSLETTER_REPLY_TO` — optional, and currently unset. Point it at a mailbox
  Erik actually reads if readers should be able to reply; pointing it at an
  address that does not exist is worse than leaving it off, because the reply
  bounces silently instead of never being offered.
- `ANTHROPIC_API_KEY` — the shared secret, same as the other apps

`gcpdeploy ship` deliberately swaps only the image digest and never
reconstructs env vars, so **adding these is a one-time manual update** to the
service, not something a normal deploy does. That is the safety property that
stops a stale config file from dropping a secret from production; do not
"fix" it by declaring env vars in `apps.json`.

### The admin password can be changed from the admin page

`ADMIN_PASSWORD` used to be the whole story, and it lived in an env var fed
from `landing-admin-password` — so changing it meant a new secret version and
a redeploy, and forgetting it meant editing the service.

`shared/sitepass.js` now backs it: a scrypt hash in `control/site-password`,
preferred over `ADMIN_PASSWORD` when present. The env var stays as the
**bootstrap** — what works on a fresh deploy, and what still works if the
stored record is cleared. The plaintext is never stored, and the row is in the
same database as everything else, so no new infrastructure.

The admin session cookie carries `via` — how the session was proved:

- A **Face ID** session may set a new password without the old one. There is
  no mail sender on this service, so no reset link is possible; Face ID is the
  only reset door there is, which is the argument for enrolling one before it
  is needed.
- A **password-proved** session may not. It must produce the current password,
  or a stolen cookie could replace it and take the account permanently.

Sessions issued before `via` existed parse as password-proved, so nobody was
signed out. `/api/admin/me` reports `via` and whether a custom password is set;
the UI is in the "Face ID & password" sheet on `/admin`.

**`adminPasswordOk` is async now.** `if (!adminPasswordOk(...))` is always
false once it returns a Promise — which would have let any signed-in session
enrol a passkey with no password at all. `lib/passkeys.js` awaits it. If you
add a password check here, await it.

### Degrading instead of breaking

Each dependency is optional and the service says so rather than failing:

| Missing | What happens |
|---|---|
| `FIRESTORE_DATABASE_ID` | In-memory store, nothing persisted. The admin UI shows a warning pill. Fine for local work, never for production. |
| `RESEND_API_KEY` / `NEWSLETTER_FROM` | Signups are recorded as pending, no mail goes out, sending returns 503 with a clear message. |
| `ANTHROPIC_API_KEY` | The Claude tab reports itself off. Writing and sending are unaffected. |
| `ADMIN_PASSWORD` | `/admin` cannot be entered *unless a password has been stored* (see above). The public site is unaffected. |

The landing page keeps serving in every one of those cases. That is
deliberate: the front page must not depend on the newsletter.

### DNS, which is Erik's step

Resend needs SPF and DKIM records on `strongtechnicalconsulting.com` before it
will send as that domain, and a DMARC record is worth adding at the same time.
Resend's dashboard prints the exact records when the domain is added. Until
those records resolve, mail either does not send or lands in spam.

This is the same class of step as the Cloud Run domain mappings: the records go
in at the registrar by hand.


### Live state of the writing section (2026-09-20)

Done:

- Firestore database `eriks-projects` (Native mode, us-central1)
- Composite index on `posts`: `status ASC, publishedAt DESC`
- Secrets `landing-session-secret`, `landing-admin-password`, `resend-api-key`
- The `landing-page` service carries `GOOGLE_CLOUD_PROJECT`,
  `FIRESTORE_DATABASE_ID`, `SITE_ORIGIN`, `NEWSLETTER_FROM`,
  `NODE_ENV`, and secret refs for `SESSION_SECRET`,
  `ADMIN_PASSWORD`, `RESEND_API_KEY` and the shared `ANTHROPIC_API_KEY`.

Still Erik's, and sending will not work until it is done:

- Add `strongtechnicalconsulting.com` as a domain in Resend and put the SPF
  and DKIM records it prints at the registrar. Until those resolve, Resend
  only sends from its own sandbox address to Erik's own account address.
- Make sure something receives at `Erik.Strong@strongtechnicalconsulting.com`,
  a mailbox or a forwarding alias. Otherwise replies bounce. Alternatively set
  `NEWSLETTER_REPLY_TO` to an address he does read, which can be off-domain.

Because `gcpdeploy ship` swaps only the image digest, a normal deploy will
never disturb any of the above. If the service ever loses these env vars, it
was not `ship` that did it.

## Health checks: /api/health, never /healthz

Cloud Run's edge swallows `/healthz`. In production it returns 404 with no
`Server` header — on the `run.app` URL and the custom domain alike — while
every other path, including ones the app does not define, reaches the app.
It works fine locally, which is how it went unnoticed: the boot checks and CI
were testing a route no external monitor could reach, and the first live run
of the uptime probe reported all seven apps down while every one was serving.

Every app now answers `/api/health` with the same handler. Point monitors
there. Keep `/healthz` for local and CI use — it works there and the boot
scripts already use it.
