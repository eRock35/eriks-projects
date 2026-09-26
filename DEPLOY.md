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
./.claude/skills/deploy/gcpdeploy ship <app>
./.claude/skills/deploy/gcpdeploy create <app>
./.claude/skills/deploy/gcpdeploy verify <app>
./.claude/skills/deploy/gcpdeploy page
```

`<app>` is any key in `.claude/skills/deploy/apps.json`, one per app —
`landing` for this site, `challenge` for the lab, and so on. `create` is the first deploy of a
new app (see "Creating a service"). `page` uploads `site/index.html` to the
old landing bucket, which is a rollback copy now, not the live site — the
live site is the `landing` entry, shipped like any other app.

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
- Landing page bucket `www.strongtechnicalconsulting.com` — where the page
  lived as static website hosting before it moved to Cloud Run. Kept only as
  a rollback; no hostname serves from it (see "Domain mappings").
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

`gcpdeploy ship` updates an existing service; it cannot create one.
`gcpdeploy create <app>` does the first deploy for the shape every new app
shares — its own database (created if missing), running as `<service>-run@`,
the identity env and the `anthropic-api-key` and `identity-session-secret`
secrets, `cpuIdle: true`, minimum instances 0, public invoker, and with
`--domain` its mapping. It refuses when the runtime account does not exist
yet: Erik creates it with `scripts/new-app-accounts.sh <service>` in Cloud
Shell, because the deployer holds no IAM-admin rights. The argument is the
**service** name, not the `apps.json` key: the script makes `<name>-run@` and
conditions its datastore access on a database called `<name>`, so for a key
that differs from its service (`beer` -> `hopscotch`, `trip` ->
`trip-planner`) the key would make the wrong account. A new app should use one
name for its `apps.json` key, its service and its database. The Challenge Lab
went out this way on 2026-09-24.

For anything `create` cannot do, build first, then POST the service once:

```
POST run.googleapis.com/v2/projects/$P/locations/us-central1/services?serviceId=<name>
```

with `template.containers[0].image` pinned to the digest, then grant
`roles/run.invoker` to `allUsers` via `:setIamPolicy` if it's public. After
that, `gcpdeploy ship` handles every later deploy.

Two things Cloud Run will reject or overcharge for:

- **Set `resources.cpuIdle: true` on EVERY service, explicitly.** In the v2
  API, a container that declares `resources.limits` and leaves `cpuIdle`
  unset gets CPU always-allocated — instance-based billing, charged for every
  second an instance is alive, including the ~15 idle minutes after each
  request. `cpuIdle: true` bills only while a request is in flight. (Under
  512Mi it is also mandatory; 256Mi is rejected without it.)

  This cost real money until 2026-09-23. Five services (football,
  trip-planner, friction, dataviz, santa-rosa) had it unset and were billed
  ~296 instance-hours in 30 days for ~2 hours of actual request handling —
  roughly $15/month after the free tier, for traffic the free tier covers
  entirely on request-based billing. The landing page, on `cpuIdle: true`,
  served the MOST requests (15.8k) and was billed half an hour. All eight
  services are request-based now, and `challenge`, created the next day, was
  born that way. `gcpdeploy ship` copies the live template, so the setting
  survives deploys; a new service must set it itself (`create` does).

  **The rule this imposes on code: never keep working after the response.**
  Between requests the CPU is throttled to near zero, so anything
  fire-and-forget — respond 202 then process, a `setInterval` sweep, a
  promise left running after `res.json()` — stalls until the next request.
  Every cron route here awaits its work before responding (checked
  2026-09-23), and `streamedJson`'s heartbeat runs inside an open request,
  which keeps CPU allocated. Keep it that way; a job that needs to outlive its
  request needs a Cloud Run job, not a detached promise.
- **Leave `minInstanceCount` at 0.** Any other value is a standing charge. For
  the landing page that is the entire reason it is on Cloud Run rather than
  behind a load balancer.
- **Old images clean themselves up.** The `erik-projects` Artifact Registry
  repository has a cleanup policy (2026-09-23): delete versions older than 7
  days UNLESS among the 5 newest of that image. Every running service ran its
  image's newest version when it was set, and each deploy pushes a new one, so
  rollback reaches back five deploys per app. It was 3.6 GB and growing with
  no policy at all.
- **Trip photos live in Cloud Storage, one private bucket per app**
  (2026-09-23): public access prevention enforced, uniform access, each
  bucket readable only by its own app's runtime account (see
  `docs/phase4-runtime-service-accounts.md`). Mounted as `PHOTOS_BUCKET`;
  without it the Memories feature reports itself unavailable. The apps stream
  every photo themselves through their sign-in check — no public objects, no
  signed URLs. `shared/photostore.js` is the client.

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
| Trip Planner | `trip-planner` | `trip-planner` | `trip.strongtechnicalconsulting.com` |
| Santa Rosa Beach Trip | `santa-rosa-beach-trip` | `santa-rosa-beach-trip` | *URL not written down — see below* |
| Landing page + writing | `landing-page` | `eriks-projects` | `strongtechnicalconsulting.com` (`www.` 301s to it; `acct.` is the account page) |
| Friction (signal board) | `friction` | `friction` | `friction.strongtechnicalconsulting.com` |
| DataViz (animated charts) | `dataviz` | `dataviz` | `dataviz.strongtechnicalconsulting.com` |
| Spellbook (prompt library) | `spellbook` | `spellbook` | `spellbook.strongtechnicalconsulting.com` |
| Challenge Lab (every trial app) | `challenge` | `challenge` | `challenge.strongtechnicalconsulting.com`, each app at `/<slug>/` |

Per-app secrets are deliberately **not** shared. The football app's login is the
kind of thing Erik might hand to a friend so they can run research; that password
must not also open the trip apps.

- Football: `site-login-username`, `site-login-password`, `cfb-session-secret`, `cron-secret`
- Trip Planner: `trip-planner-login-username`, `-login-password`, `-cron-secret`, `-session-secret`
- Santa Rosa: `vacation-login-username`, `vacation-login-password`, `vacation-session-secret`
- Landing page: `landing-session-secret`, `landing-admin-password`, `resend-api-key`
- Friction: `friction-app-password`, `friction-session-secret`, `friction-cron-secret`
- DataViz: `dataviz-session-secret`
- Challenge Lab: none of its own, on purpose — only the shared
  `anthropic-api-key` and `identity-session-secret`. A daily drop that needs
  a secret is the wrong idea for a daily drop (see "The Challenge Lab").
- Billing, domain-wide and NOT DataViz's own: `stripe-secret-key`,
  `stripe-webhook-secret`, `stripe-member-price`. The webhook is DataViz's
  alone; since 2026-09-22 checkout is served by each of the five services
  that hold the key, and what it sells is an account-level membership that spends
  in every app — see "Billing" below. Renamed off the `dataviz-` prefix on
  2026-09-21 for exactly that reason.

Don't write the Santa Rosa app's literal `*.run.app` URL into any public file.
See **Settled decisions**.

### Why one app has no custom domain

A Cloud Run domain mapping provisions a certificate for that exact hostname,
which publishes it to public **Certificate Transparency logs** that bots scrape.
The default `*.run.app` URL rides Google's wildcard cert, so the service name
never appears there.

`santa-rosa-beach-trip` holds two young kids' details, exact travel dates, and
rental confirmation numbers. The quieter URL beat the nicer one. That trade has
since been revisited — see **Settled decisions**. The app keeps its `*.run.app`
URL; don't add a domain mapping for it.

This heading used to say two apps. Trip Planner was the other, and has been on
`trip.` since 2026-09-20: its repo is public, it is open to registration and
its `*.run.app` URL was already linked from this page, so there was no quiet
URL there to protect.

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
swipeable strip of phone-shaped frames — six of them, in the same order as
the cards below: football, Hopscotch (`/?tour=1#trips`), trip-planner,
DataViz, Friction's `/preview`, and Spellbook's front page. Each frame loads
only when it scrolls near (six cold starts on page load would be silly), the
app inside renders at 390px and is scaled to fit, and a transparent layer
over each keeps swipes on the strip and turns a tap into "open the app", in
a new tab.

**A frame is not a visit.** Until 2026-09-25 every frame ran the view beacon,
so each visitor who scrolled to the strip counted as a view of five apps
(Friction's `/preview` never carried it). The beacon now stays silent when framed or on `?tour=`, and the counter refuses a
sender that says it is an embed — see "Previews are not views" under "View
counts".

**Tour mode.** Every framed URL but Spellbook's carries `?tour=1`, and the
app then runs a scripted loop on itself so the frame looks used: trip-planner
reads the example chat, types a question and shows a canned answer arrive,
opens a day, glances at the watches; football scrolls the card, opens a
"why", visits the board; Hopscotch plans a crawl (types a city, finds the
breweries, builds the route) without saving or asking the sommelier; DataViz
plays one free sample after another; Friction reads down the preview.
Spellbook has no tour and is simply shown. `shared/tour.js` is the helper
(copied into each app's `public/`; Friction serves it before the gate). Three
rules it keeps: nothing it does costs money - chat answers are canned and
drawn into the DOM, DataViz taps only samples marked `free` by
`/api/datasets`; it runs only with `?tour=1` and never under reduced motion; a
failing step restarts the loop rather than leaving the page half-animated.

**`Content-Security-Policy: frame-ancestors`** on football, trip-planner,
dataviz, friction and the Challenge Lab allows `'self'` plus
`strongtechnicalconsulting.com` and `www.`. Nothing set X-Frame-Options
before, so anyone could frame these apps; this narrows it to the landing
page. Hopscotch's build cannot run in the sandbox so it has no such header
yet, and Spellbook sets none either — both frame because nothing forbids it.

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

### Where checkout is served (2026-09-22)

It used to be DataViz alone, and every other app's "AI credit" was a link
there. What that link sold was never DataViz's — the membership covers all
five apps and the balance spends in all five — so the reader was sent into a
chart app they were not using, styled like a different product, to manage an
account that has nothing to do with it. Erik's words: "I don't like when I
press ai credits it takes me to data viz."

The checkout routes live in `shared/identity.js` now, under whatever path each
app mounts identity on:

| | |
|---|---|
| `GET <mount>/billing` | what is on offer, and what this account has paid |
| `POST <mount>/billing/membership` | → a Stripe Checkout URL |
| `POST <mount>/billing/credit` | → the same, for a top-up |
| `POST <mount>/billing/portal` | → the Stripe-hosted billing page |

`<mount>` is `/api/id` on football, friction and the landing site, `/api/auth`
on trip-planner and DataViz. Each app draws its own sheet in its own styling
and passes its OWN origin as `success_url`, so a purchase started in the trip
planner ends in the trip planner.

`returnTo` is a **path**, and is checked for it. Stripe follows `success_url`
after a real payment, so an absolute one there would be an open redirect with
a card charge attached; `//evil.example` is a URL wearing a path's clothes and
is refused too.

**The webhook did not move.** Stripe delivers to one endpoint, and
`STRIPE_WEBHOOK_SECRET` has no reason to exist on five services to serve one
of them. Only the ability to CREATE a checkout session spreads, which is why
the split is worth keeping: a key that can mint a checkout session is a much
smaller thing to hold than one that can also forge a payment confirmation.

**A service with no Stripe key still behaves.** `topUpUrl()` and the
`elsewhere` field follow the money: a service holding the key answers with a
relative `?topup=1` that opens its own sheet, and one without it names a
service that can actually sell. So an app deployed before its secrets are
bound shows the balance in its own sheet and a button out, rather than a
dead-end saying "not switched on" — and the button comes home the moment the
key is mounted. That is a fallback, not the intended state.

### The secrets, and which services need them

`STRIPE_SECRET_KEY` and `STRIPE_MEMBER_PRICE_ID` are needed by **every**
service that offers checkout; `STRIPE_WEBHOOK_SECRET` by **exactly one**
(DataViz). `STRIPE_PRICE_ID` — the old Pro price — is read by nothing and
should not be set on any service.

Binding a secret to a runtime service account is
`secretmanager.secrets.setIamPolicy`, which the deployer does hold. All five
runtime accounts — `dataviz-run@`, `trip-planner-run@`, `football-run@`,
`friction-run@`, `landing-run@` — hold `secretAccessor` on `stripe-secret-key`
and `stripe-member-price` as of 2026-09-22, and all five services mount the two
env vars. `stripe-webhook-secret` is bound to `dataviz-run@` only, and should
stay that way.

**The key in `stripe-secret-key` is already a RESTRICTED key** (`rk_live_`),
not a full `sk_live_`. That is what makes spreading it to five containers
reasonable: minting a checkout session needs write on Checkout Sessions and
Billing Portal Sessions and read on Prices and Customers, and none of that can
issue a refund or read the charge history. If it is ever replaced, replace it
with another restricted key — an `sk_live_` here would quietly widen five
containers at once.

### The API version was invented, and nothing ever worked (2026-09-22)

`stripe.js` hardcoded `Stripe-Version: 2026-08-27.basil`. That is not a Stripe
API version: the current train is `dahlia`, and basil never had an 08-27. So
**every** call this code has ever made returned `Invalid Stripe API version` —
checkout, the billing portal, and the Price read behind `/api/stripe/health`,
which was therefore answering `ok: false` rather than confirming anything. It
went unnoticed because nothing had ever been bought and nobody read the health
route's body.

It survived review twice because it is **untestable from here**: this container
cannot reach `api.stripe.com`, the suites stub `fetch`, and no stub looked at
the header. A string only the real Stripe can judge should not be hardcoded by
someone who cannot ask it.

The fix is to send **no version header**, so Stripe uses the account's default
API version — correct by construction, and the same version the webhook
endpoint renders events in. `STRIPE_API_VERSION` pins one deliberately once
somebody has confirmed it against the account.

`test/billing-anywhere.js` now rejects, in the stub, any version the real
Stripe would reject. That is the general lesson and the one worth keeping: a
fake that accepts anything proves nothing.

### Nothing has been bought yet, so the write path is unproven

`GET /api/stripe/health` proves the key can **read** a Price. It does not prove
the key can **write** a Checkout Session, and as of 2026-09-22 the live account
has never had one: `GET /v1/checkout/sessions` returns an empty list. So a
missing permission on the restricted key would first show up as a failed
purchase, not as a failed health check.

Pressing "Become a member" and then closing Stripe's page is the whole test:
it creates the session (proving the write) and charges nothing.

### The customer portal (2026-09-22)

Erik switched it on: `bpc_1UIIaUFbShmvZtSfnAxAe1K0`, live, default, so
`POST <mount>/billing/portal` has something to open. Cancellation is
**`at_period_end`** with no proration, which is the setting the entitlement
code assumes — a cancelling member keeps the tier until the period they paid
for runs out, and `customer.subscription.deleted` is what finally drops it.

`subscription_update` is off, which is right while there is one thing to buy:
there is nothing to switch to, and an update flow would only offer a decision
that does not exist.

**`current_period_end` moved.** Stripe's basil release took it off the
Subscription object and put it on the subscription's items, and this webhook
endpoint has `api_version: null` — it renders in the account's default version,
whatever that becomes. The handler reads both places. Reading only the old one
wrote `null` forever, which silently retired `isMember`'s expiry check: the
only cover for a `customer.subscription.deleted` that never arrives.

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
- **`/admin/views`** is the cross-app view dashboard — the whole picture,
  landing page included (see "View counts").
- **`/admin/inbox`** is the ideas inbox (see "The ideas inbox" below).
- **`/admin/insights`** 301s to `/admin`, so older links still land somewhere
  sensible.
- Everything under `/admin` answers **404** to a non-admin, not 403, so the
  surface is not advertised.

Ordering on the overview is deliberate: the two "something needs you" sections
(requests, then health) sit together, and the control that emails them comes
after the things it reports.

### The ideas inbox (2026-09-26)

Erik asked for "something where I can just text you ideas you can store and
maybe act on", and chose Siri plus a private page. **No reminders** - he
dropped them: nothing here has a due date or pings anyone.

- **Storage:** collection `inbox` in this service's own database
  (`eriks-projects`), one document per item: `text` (cleaned, <= 2000),
  `kind` (idea / app idea / feature / bug / note - guessed from keywords or a
  spoken "Bug:" prefix, editable), `source` (siri / page), `status` (new /
  seen / doing / done / parked), `claudeNote` (<= 1000), `tags` (from
  #hashtags), `createdAt`, `updatedAt`, `day`. Caps: 2,000 in all, 100 a day.
  No composite index: a status filter is an equality query sorted in memory.
- **Doors:** the admin session, or a bearer token generated on the page's
  "Set up Siri" section. The token (`ibx_` + 32 random bytes) is shown once;
  only its SHA-256 is kept, at `control/inbox-token`. Generating a new one
  replaces the old; "Turn off" deletes it. 30 requests a minute per token,
  20 wrong tokens a minute per address, 128 KB bodies, read only after the
  token or session is checked (the global JSON parser skips `/api/inbox*`).
  Cookie-authenticated writes need the page's `X-Inbox-Page` header, because
  `challenge.` is same-site and SameSite cookies do not stop it.
- **Routes:** `POST /api/inbox` (`{text, kind?}` JSON, a form, or bare
  text/plain; answers `{ok, id, message: "Saved: ..."}` for Siri to speak),
  `GET /api/inbox?status=`, `PATCH /api/inbox/:id` (`status`, `claudeNote`,
  `kind`, `tags` - never the text), `DELETE /api/inbox/:id` (page only),
  `GET|POST|DELETE /api/inbox/token` (admin only, 404 otherwise). Missing or
  bad tokens are a 401 with a sentence Siri can read out.
- **The daily run** cannot reach the site, so it uses Firestore REST with the
  deploy token: `node scripts/inbox.js list [--status new]` and
  `node scripts/inbox.js note <id> --status seen|doing|done|parked --note "..."`.
  It needs the deployer's existing access to `eriks-projects`; nothing new to
  bind.
- The page runs under a CSP with no inline script (`site/assets/inbox.js`
  holds all of it, and `test/inbox.js` renders hostile items through it).

## The shared account

One email + password + passkey opens landing, football, friction, trip-planner
and dataviz, and Spellbook and every Challenge Lab app since (each lab app
mounts it at its own `/<slug>/api/auth`). `shared/identity.js` owns the user record, the session cookie and
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

### Managing the account: `acct.strongtechnicalconsulting.com`

One page for the account itself - display name, plan and remaining credit,
which apps it opens, passkeys (add here, remove any), the password, a
bring-your-own key, and deleting the whole thing.

The subdomain is a **domain mapping onto the landing service**, not a service
of its own: identity is already mounted there, so a separate service would
have needed new secrets and a new runtime account to say the same things. The
landing service serves `account.html` at `/` when the host is `acct.`, scoped
by hostname so the apex still serves the marketing site, and `/account`
remains an alias on every host so older links keep working. Everything else
answers on that host too - `/api/id/*`, `/reset`, `/passkey-client.js` - which
is load-bearing rather than incidental, since the page fetches all of them
relative to wherever it was served from.


Two routes exist only for it:

- `POST /api/id/profile` - display name, and only that. The email derives the
  uid every app keys its data by, so changing it would orphan every trip,
  project and slip that person owns. That is a migration, not a text field.
- `DELETE /api/id/account` - removes the record, the passkeys, the stored key
  and the grants. Proof is the same standard as changing the password: a
  passkey session is enough alone, a password one must produce the password.
  It does NOT delete what lives in each app's own database, and the page says
  so rather than implying a deletion that did not happen. The record is
  removed rather than tombstoned, so the address can register again - the cost
  is that re-registering derives the same uid and reclaims whatever app data
  still references it, which is the assumption every app already makes.

### Signing in from inside each app

A portable cookie is not the same as a way in. Until 2026-09-21 friction's
login page asked only for the app password and football's account sheet only
offered its own registration, so the shared account could only be used by
signing in somewhere else and navigating back. Both now post to their own
`/api/id/login` mount, and friction's Face ID button looks in the shared
passkey store first and its own second. The legacy doors stay: an app password
that cannot be broken by a fault in the identity service is worth keeping.

### Hopscotch asks rather than reads

Hopscotch keeps its own users - pours, cellars and trips are keyed by its own
`u_...` ids - so the shared account is a second DOOR there, not a migration.
Identity says who; the local row, matched on email, stays what the data points
at.

`beer-app/server/src/shared-identity.js` forwards the `stc_session` cookie to
**`/api/id/me` on the landing service** and takes the answer. It does not
verify the cookie itself and does not read the `identity` database, and that
is the design rather than a shortcut:

- **Less privilege.** Hopscotch holds no signing secret, so it cannot mint a
  session for anyone, and no identity-database credentials, so it cannot read
  any record except the one whose cookie was handed to it.
- **Revocation is real.** The answer comes from the live record, so an account
  deleted on `/account` stops opening Hopscotch within the cache window rather
  than lasting until the cookie expires.
- **It needed no IAM.** The first version verified the cookie locally and read
  the identity database, which wanted `secretAccessor` plus `datastore.user`
  scoped to that database. The deployer can set secret-level IAM but has no
  `resourcemanager.projects.setIamPolicy`, and Firestore has no per-database
  IAM policy to set instead - so that version could not be switched on without
  a console step. This one shipped working.

The cost is one HTTPS round trip per check, cached for 60s against a hash of
the cookie (never the cookie itself - a session token in a long-lived map is a
credential in memory for no reason). An unreachable identity service fails
closed: shared sign-in stops, Hopscotch's own accounts carry on.

`IDENTITY_VERIFY_URL` overrides the endpoint and, set empty, turns shared
sign-in off entirely. Unset means the production landing service, so no env
var is required on the service.

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

## View counts and "what's trending" (2026-09-22)

Separate from GA and not a replacement for it. GA answers questions about
sessions and behaviour; this answers one question — which of Erik's apps is
getting used this week — and it answers it from a first-party counter he owns,
so the landing page can badge the leader without asking Google at render time.

- `lib/views.js` — the whole thing: the beacon endpoint, the rollups, and the
  two read endpoints. It runs on **this** service.
- `shared/beacon.js` — the browser half, copied into every app by
  `scripts/sync-shared.js`. One `<script src="/beacon.js" data-app="NAME">` tag
  per app; the `data-app` value must be a key in the `APPS` allowlist. It
  POSTs to `https://www.strongtechnicalconsulting.com/api/beacon` from every
  app, which is one reason the www redirect leaves `/api/*` alone (see "One
  canonical host").
- `site/views.html` at `/admin/views` — the dashboard, admin-gated.
- `GET /api/stats/public` — counts and shape only, CORS-open to the domain.
  `GET /api/admin/stats` — uniques, top paths, referrer hosts; 404s otherwise.

**It lived in Spellbook until 2026-09-22.** The reasoning for putting it there
was that the landing service was static and dependency-light and a database
would make it a real backend. By then it already had a Firestore, an admin
gate, the identity store, an uptime prober and a cron, so the premise was
stale and the effect was that the numbers for seven apps sat inside one of the
seven — and the root domain made a cross-origin call to an app subdomain in
order to draw itself. The counters restarted with the move; they were a day
old, and re-basing them would have meant copying rows between databases to
avoid admitting a gap of one day.

### What is stored, and what deliberately is not

Stored: the app name, a coarse path, the referrer **host**, an opaque random
visitor id in a first-party cookie, and counters.

Not stored: IP addresses, user agents, full referrer URLs, query strings, or
anything tied to a signed-in identity. Enough to count and rank, not enough to
follow a person. Don't add an IP column "just for geo" without deciding that
tradeoff out loud.

**`santa-rosa-beach-trip` is not in the allowlist and must not be added.** It
is private, holds family PII, and its hostname is deliberately kept off public
surfaces — `/api/stats/public` is public and this repo is public.
`test/views.js` asserts its absence, so the addition fails loudly.

### Two things that bit once each

- **The beacon sends a host; the server parsed a URL.** `shared/beacon.js`
  reduces `document.referrer` to its host before sending, and `referrerHost()`
  ran `new URL()` on it, which throws. Every referrer was silently dropped and
  the dashboard said "No external referrers yet" under every app while traffic
  was arriving. It takes either shape now.
- **Seven apps, five colours.** `colorFor()` folded everything past slot 5 into
  slot 5, so Spellbook, DataViz and Friction drew as the same pink. `APP_ORDER`
  is append-only and there are seven slots; adding a name to the end gives the
  new app the next colour and repaints nothing.

### Previews are not views (2026-09-25)

The landing page frames the apps as live phone previews, and every frame ran
the beacon: each visitor who scrolled to the strip posted a view for Football,
Hopscotch, Trip Planner, DataViz and Spellbook, and a unique the first time
that day (the frames share the landing page's visitor cookie). Friction's
`/preview` never carried the beacon. So "Most used this week" and the
Trending badge mostly ranked how far down the page visitors scrolled.

- **The beacon stays silent when framed** (`window.self !== window.top`, and
  a page that throws on touching `window.top` counts as framed) **or when the
  URL has a `tour` parameter**, with any value. The frame test is the main
  rule: Spellbook's preview has no `?tour=1`. A real visit is never framed —
  a tap on a preview opens the app in a new, top-level tab with no tour
  parameter, and that still counts (except Friction, whose tap opens its
  public `/preview`, which carries no beacon: Friction's count is only its
  own signed-in use).
- **The server refuses what says it is not a view.** `beaconVerdict()` in
  `lib/views.js` drops a body with `embed` set, a `path` carrying `tour`, an
  unknown app or a bot, before any cookie is set — a request that is not a
  view should not mint a visitor either. It is pure, so `test/views.js`
  tests the rules without a database.
- **An old beacon cannot be recognised.** It posts the same body, referrer
  host and headers as a genuine tap through from the landing page, so each
  app's numbers are clean only from that app's first deploy carrying the new
  `beacon.js`. Ship them all on the same day, or the ranking compares clean
  numbers with inflated ones.
- **The stored counts were not rewritten** — there is no telling which old
  views were frames. Counted from the last app's redeploy, the inflation
  leaves `views7` (the strip and the badge) after 7 days, `views7Prev` and
  `trendPct` after 14 (in days 8-14 the trend reads as a steep fall that is
  an artifact, not a drop in use), the 30-day figures after 30 and the admin
  90-day series after 90. `totalViews`, `totalUniques` and per-path counts are
  running totals with no window and carry it for good, which is why the
  landing page no longer shows any of them.

### On the landing page

Two surfaces, both fed by the same `/api/stats/public` call and both additive:

- **A ranked strip** ("Most used this week") above the previews. The landing
  page itself is filtered out of it — every visitor arrives there first, so it
  would sit at #1 every week and say nothing about the apps. An app with no
  views is left out rather than listed at zero, and the strip is not drawn at
  all below two rows, because a ranking of one is not a ranking. `/admin/views`
  keeps the whole picture, landing page included.
- **Per-card labels**: a "Trending" badge and "N views this week".

Both rank, draw and scale on **one** number, `views7`. An app with no views
this week is not "most used this week", and one big all-time count would
shrink every weekly bar beside it. A card gets its label only when it has
views this week, and the label always reads "N views this week"; the
all-time fallback is gone, because the all-time totals carry the preview
inflation above for good, and a card saying "N views" beside others saying
"N views this week" mixed two different numbers.

It **labels rather than reorders**. Sorting cards by rank would reshuffle the
page on every visit and fight the staggered `--d` reveal delays baked into the
markup. The fetch runs after paint and swallows every failure, so no card
depends on it.

The badge keys off the busiest **app**, not `rank === 1`. Rank is across
everything the counter tracks and #1 is always the landing page, which has no
card — so the original version could never have shown the badge on anything.
And it goes only to a **clear leader**: more than one app with views this
week, and the first strictly ahead of the second. The server breaks `views7`
ties on all-time totals, so first place in a tie is not earned, and a single
app with views has nothing to lead. No leader, no badge.

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

Live mappings: `strongtechnicalconsulting.com` and `www` -> landing-page
(the apex is the canonical address and `www` 301s to it; see "One canonical
host" below), `acct` -> landing-page (the account page; see "The shared
account"), `trip`, `footballapp`, `friction`, `dataviz`, `beer`, `spellbook`
-> their own services, and `challenge` -> the lab's `challenge` service
(created 2026-09-24 by `gcpdeploy create --domain`; its
`CNAME challenge -> ghs.googlehosted.com.` is in place as of 2026-09-25, and
the lab answers on `challenge.strongtechnicalconsulting.com` — see
`challenge/CLAUDE.md`).

**Before mapping anything, re-read "Settled decisions".** One app must never
get a mapping.

## One canonical host, and how the site is served (2026-09-25)

The landing service answers on the apex and on `www.`. Two addresses for every
page split links and search ranking between them and make the canonical tag a
guess, so **the apex is THE address**: a GET or HEAD on `www.` gets a **301**
to the same path and query on `https://strongtechnicalconsulting.com`. The
target is a fixed origin plus the request's own path, so a path like
`//elsewhere.example` cannot turn it into an open redirect — and only an
origin-form target (one starting with `/`) is redirected. Node also accepts
absolute-form (`GET http://evil.example/y HTTP/1.1`, or `GET munity://x/y`,
which glued onto the origin reads as the host
`strongtechnicalconsulting.community`); those are served as asked rather than
redirected. Keep the concatenation: `new URL(path, origin)` would resolve
`//elsewhere.example` off-host. The redirect is
cached for a day (`max-age=86400`) rather than left bare: browsers otherwise
keep a 301 for good, which would make a mistake here one nobody could take
back.

Deliberately **not** redirected on `www.`:

- **`/api/*`.** Every app's view beacon POSTs to `www./api/beacon`, and pages
  fetch `/api/stats/public` cross-origin. A CORS preflight that gets a
  redirect fails outright, and so would the count.
- **Anything but GET and HEAD.** A 301 turns a POST into a GET in every
  browser, which would drop a subscribe form, or a one-click unsubscribe from
  an email that still carries a www link, on the floor.
- **`/healthz`** is left alone only so it behaves the same locally and in CI.
  In production Cloud Run's edge answers it (see "Health checks"), and the
  probe that reaches the app is `/api/health`, already covered by `/api/*`.
- **`/robots.txt`**, per host by definition (RFC 9309). Answered directly, a
  crawler that will not follow a redirect for it still reads the rules.
- **`/.well-known/*`**, per host by definition (RFC 8615) — a certificate
  challenge for the www mapping bounced to another host would fail renewal.

Only the www host redirects. `acct.`, the `*.run.app` URL, localhost and the
tests are served exactly as before.

**Every absolute URL names the apex.** The page's canonical link, `og:url`,
share image (`/assets/og-home.jpg`, 1200×630 — the square portrait lost the
top of the head in a 2:1 crop) and its JSON-LD (a `Person` and a `WebSite`,
saying only what the page says) all do. `/challenge` carries its own apex
canonical and `og:url` and the same share card, which is also the default
image for the `/writing` pages (with its 1200×630 size stated). So do links this service builds from
`SITE_ORIGIN` — feed, confirm, unsubscribe and reset links — because a
`SITE_ORIGIN` of the www host, or none at all, is read as the apex; any other
value (a staging host, localhost) is taken as meant. **One exception: the
feed's `<guid>`s stay on www for good** (`GUID_ORIGIN` in `lib/render.js`,
`isPermaLink="false"`). Feed readers deduplicate on the GUID, and every GUID
the feed has published was a www URL, so moving them would show every
subscriber the whole archive again as unread — and moving them back would do
it a second time. `<link>` moves to the apex; the GUID never does. See "What the service
needs" for the value production should carry.

**`/sitemap.xml`** lists `/`, `/challenge`, `/writing`, `/privacy` and
`/terms`, plus every published post from the same query `/writing` uses (so a
post is listed exactly when it is readable), all on the apex, with a
`lastmod` on posts and on `/writing`. A store failure still returns the static
pages: leaving a URL out of a sitemap is not a removal request. Cached ten
minutes. On `acct.` it is a 404 — a sitemap there listing the apex's pages
would be a cross-host sitemap.

**`/robots.txt`** disallows `/admin` and lists `sitemap.xml` and `feed.xml` on
the apex, whichever host asked. On `acct.` it is `Disallow: /`: an account
page with a sign-in form has no business in a search index.

**Compression.** `compression` gzips or brotli-encodes text (HTML, CSS, JS,
JSON, SVG, XML) with `Vary: Accept-Encoding`; images are already compressed
and are left alone. Two exclusions: `text/event-stream`, because a compressor
holds bytes back until it has a block worth emitting, and 206 partial
content. Nothing here streams today; a route that ever sends a whitespace
heartbeat, like trip-planner's `streamedJson`, must set
`Cache-Control: no-transform` or call `res.flush()` after each write.

**Caching.**

| What | `Cache-Control` |
|---|---|
| HTML, CSS, JS from `site/` | 5 minutes |
| Images and fonts under `/assets` | a week (`max-age=604800`) |
| `/writing` | 2 minutes |
| A post | 5 minutes |
| `/feed.xml`, `/sitemap.xml` | 10 minutes |
| The www redirect | a day |

None of the asset names are fingerprinted, so an image replaced in place can
show the old one for up to a week: **give a changed image a new name**
(`erik-420.jpg` -> `erik-420-v2.jpg`). ETags stay on, so once the week is up a
browser revalidates with a 304 rather than downloading it again. Express's
static ETags are weak, which is what makes one ETag right for both the
compressed and the plain body.

**Unknown paths** still show the landing page, so a mistyped link is never a
dead end, but with a **404** status: answering 200 told search engines every
made-up path was a copy of the home page. A path that looks like a file
(`/favicon.ico`, `/x.png`) gets a plain 404.

`test/canonical.js` holds all of it, including what must not move: the www
beacon POST and an old email's one-click unsubscribe POST.

**One side effect.** The `ADMIN_PASSWORD` door's session cookie (`esadmin`)
is host-only, so an admin signed in on `www.` signs in once more on the apex.
The shared account's cookie is scoped to the whole domain and carries over.

## The Challenge Lab

`challenge.strongtechnicalconsulting.com` — where the "new app every day"
experiments live while they are being tested. The source is `challenge/` in
this repo, and `challenge/CLAUDE.md` is the full guide; this is what the
runbook needs.

**One service, one database, one runtime account, on purpose**: Cloud Run
`challenge`, Firestore `challenge`, and `challenge-run@`, which holds
`logging.logWriter`, `datastore.user` on `challenge` and `identity`, and
`secretAccessor` on `anthropic-api-key` and `identity-session-secret` — the
standard set `scripts/new-app-accounts.sh` grants, and nothing more. Every
trial app is an ordinary Express app in `challenge/apps/<slug>/`, mounted by
`challenge/server.js` at `/<slug>/`; its collections are prefixed `<slug>_`,
so apps never see each other's data and graduating one is a copy of one
prefix. An app that fails to load is logged and left unmounted rather than
taking the lab down. So a new app needs **no new infrastructure at all** — no
service, no database, no runtime account, no IAM change. Creating accounts
and binding roles is the one step the deployer cannot do, so one service per
trial would have put Erik on the critical path of every drop. Same reasoning
as trip-planner's "one app, many trips": don't let "give each trial its own
deploy" creep back.

**The daily drop is a Claude Code Routine, not a Scheduler job.** "Challenge
Lab: new app every day" fires at **07:00 UTC**, picks an idea, builds it in
`challenge/apps/<slug>/`, adds it to `challenge/lab.js`, runs `npm test` in
`challenge/`, commits, and ships with `gcpdeploy ship challenge` from `main`
— two hours before the **09:00 UTC** countdown on the lab and on this site
turns over. On a holiday the drop is themed for it (the table is in
`challenge/CLAUDE.md`). **A daily run never creates infrastructure or changes
IAM**: an idea that needs a new secret, bucket or API is the wrong idea for a
daily drop.

**`challenge/TOKENS.md`** is the ledger of what each lab app cost to build,
counted from the builder agents' transcripts by `scripts/token-ledger.py`.
The daily run appends its drop there, and the Friday LinkedIn draft uses the
week's rows. Visitors' AI use in the lab is not in it; that is in the
`identity` database's `usage` collection, by `app`.

**What this site shows of it.** The lab serves `/api/lab` with CORS for the
apex and `www.` only. The home page's Challenge banner reads it without
cookies (the lab's CORS does not allow credentials, and the banner has no use
for a visitor's own votes; the lab mints its vote cookie only on its own page
or on a vote) and names the latest drop, how many apps are live and the
countdown; if the lab does not answer within a moment, the banner shows copy
that carries no numbers, so nothing stale is ever on screen. A tab left open
past 09:00 UTC asks again, and falls back to that copy if the lab is silent. `/challenge`
(`site/challenge.html`) is a **teaser**, not a second lab: the latest drop,
the locked next one with its countdown, and the rest behind "N more waiting
in the lab". Voting (keep or kill, one per browser) and the private notes to
Erik live on the lab itself.

**Graduating an app** Erik picks: `git mv challenge/apps/<slug> apps/<slug>`,
give it its own `apps.json` entry and mark it `graduated` in `lab.js` with
`home:` its new URL; Erik runs `scripts/new-app-accounts.sh <slug>`; then

```
gcpdeploy create <slug> --env PASSKEY_RP_ID=strongtechnicalconsulting.com \
  --domain <slug>.strongtechnicalconsulting.com
```

and copy its `<slug>_*` collections into its own database, without the
prefix, if the trial data is worth keeping.

## Scheduler jobs

| Job | Schedule (America/New_York) |
|---|---|
| `cfb-batch-submit` | `0 8,18 * * 2-5` |
| `cfb-batch-collect` | `30 * * * 2-6` |
| `cfb-saturday-live` | `0 9-23 * * 6` |
| `cfb-weekend-settle` | `0 10 * * 0,1` - grades last week and builds the new board |
| `trip-planner-check-watches` | `0 * * * *` |
| `hopscotch-dispatch` | `0 8 * * 4` (America/Chicago) |
| `friction-scan` | `15 6 * * *` - daily since 2026-09-21 |
| `landing-notify` | every 15 minutes - see "Email notifications" |
| `spellbook-rollup` | not recorded here; `gcpdeploy status` lists it |

The Challenge Lab's daily drop is **not** a Scheduler job. It is a Claude
Code Routine at 07:00 UTC that builds and ships an app - see "The Challenge
Lab".

`cfb-weekend-settle` used to point at `batch-submit` and now runs
`/api/research/weekly-board`: it grades the picks that were on the board
against final scores, then researches and builds the coming week's. Its
`attemptDeadline` is **900s**, not the 180s default - two web-search research
calls do not finish in three minutes, and a Scheduler deadline that short
reports DEADLINE_EXCEEDED while the app is still working. The job name is now
a lie about what it does; Scheduler job names are immutable, so renaming it
means create-new plus delete-old.

Weekday football research runs through the **Anthropic Batch API** (50% cost,
up to 24h latency) and goes live hourly on Saturdays. Batch supports
`web_search_20260209`; this was verified with a real test batch, not assumed.

`friction-scan` scans the single stalest of six lenses per run, which keeps
one invocation inside its request timeout. It fired every four hours, giving
each lens a daily cadence, until 2026-09-21: that measured ~$0.83/day on Opus
and Erik asked for less. Daily, each lens comes round about once a week. Do
not "fix" the slower cadence with one run that scans everything - that is 144
rate-limited requests in one handler.

Three apps' source lives in a **subdirectory** of this repo rather than a
repo of its own: Friction (`apps/friction`) and DataViz (`apps/dataviz`),
because the installed GitHub App cannot create repositories, and the
Challenge Lab (`challenge/`). `apps.json` handles this by setting `repo` to
the path; nothing else knows or cares.

## Known open items

- ~~Runtime service account is over-privileged.~~ Done 2026-09-21: every
  service runs as its own scoped account. The record is in
  `docs/phase4-runtime-service-accounts.md`. The deployer still holds no
  IAM-admin rights, so every new binding is Erik's to make - do not self-grant
  IAM, and do not add an env var that needs a binding before it exists.
- **Empty `cover-sheet` Firestore database (us-east4) still exists.** Deleting it
  was blocked by a safety classifier. Left in place; harmless but untidy.
- **`SITE_ORIGIN` on `landing-page` still says www.** It was set when www was
  the address. The code reads a www value as the apex, so nothing is wrong on
  the wire, but the setting should say what it means: change it to
  `https://strongtechnicalconsulting.com` on the next manual service update
  (`ship` never touches env vars; see "What the service needs").
- **A few links still name www**, and each now costs its reader a redirect:
  the fallback origin in `lib/render.js` (unreached while `server.js` sets
  `SITE_ORIGIN`), the `landing` URL in `lib/views.js`'s allowlist, and the
  `/reset` links in DataViz (`apps/dataviz/public/index.html`) and
  trip-planner (`login.html`). The beacon's own `www./api/beacon` target is
  fine as it is — `/api/*` is not redirected, and neither are the feed's
  GUIDs, which stay on www on purpose (see "One canonical host").
- **The 2026-09-25 beacon reaches each app only with that app's next
  deploy**, and each app's view counts are clean only from then (see
  "Previews are not views"). Ship them on the same day: `landing` (with
  `site/assets/og-home.jpg`), `football`, `trip`, `beer` (the beacon reaches
  Hopscotch through its Vite build), `spellbook`, `dataviz`, and `friction`,
  whose copy changes no counts and is only there to keep the copies in sync.

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
- `SITE_ORIGIN=https://strongtechnicalconsulting.com` — used to build the
  canonical and feed URLs, the confirm and unsubscribe links and the
  password-reset links, so it must match the real hostname or people get
  links to the wrong place. The apex, now that `www.` redirects there (see
  "One canonical host"). Production still carries the www value from before
  that; `server.js` reads www, or no value, as the apex, so it is harmless
  until changed, but change it (see "Known open items")
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
