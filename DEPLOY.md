# Deploy runbook

Operational reference for every app running under `strongtechnicalconsulting.com`.
Written for whoever is acting as the deploy agent — a session container is
ephemeral, so nothing here should live only in a conversation.

**This file is in a public repo.** It names infrastructure (project, services,
secret *names*, buckets) but never secret *values*. Keep it that way.

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
| Landing page | — (GCS bucket) | — | `www.strongtechnicalconsulting.com` |

Per-app secrets are deliberately **not** shared. The football app's login is the
kind of thing Erik might hand to a friend so they can run research; that password
must not also open the trip apps.

- Football: `site-login-username`, `site-login-password`, `cfb-session-secret`, `cron-secret`
- Trip Planner: `trip-planner-login-username`, `-login-password`, `-cron-secret`, `-session-secret`
- Santa Rosa: `vacation-login-username`, `vacation-login-password`, `vacation-session-secret`

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

## Scheduler jobs

| Job | Schedule (America/New_York) |
|---|---|
| `cfb-batch-submit` | `0 8,18 * * 2-5` |
| `cfb-batch-collect` | `30 * * * 2-6` |
| `cfb-saturday-live` | `0 9-23 * * 6` |
| `trip-planner-check-watches` | `0 * * * *` |
| `hopscotch-dispatch` | `0 8 * * 4` (America/Chicago) |

Weekday football research runs through the **Anthropic Batch API** (50% cost,
up to 24h latency) and goes live hourly on Saturdays. Batch supports
`web_search_20260209`; this was verified with a real test batch, not assumed.

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
