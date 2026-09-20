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

Plain env vars on the Cloud Run service:

- `FIRESTORE_DATABASE_ID=eriks-projects`
- `GOOGLE_CLOUD_PROJECT`
- `SITE_ORIGIN=https://www.strongtechnicalconsulting.com` — used to build the
  confirm and unsubscribe links, so it must match the real hostname or people
  get links to the wrong place
- `NEWSLETTER_FROM` — e.g. `Erik Strong <erik@strongtechnicalconsulting.com>`
- `NEWSLETTER_REPLY_TO` — optional
- `ANTHROPIC_API_KEY` — the shared secret, same as the other apps

`gcpdeploy ship` deliberately swaps only the image digest and never
reconstructs env vars, so **adding these is a one-time manual update** to the
service, not something a normal deploy does. That is the safety property that
stops a stale config file from dropping a secret from production; do not
"fix" it by declaring env vars in `apps.json`.

### Degrading instead of breaking

Each dependency is optional and the service says so rather than failing:

| Missing | What happens |
|---|---|
| `FIRESTORE_DATABASE_ID` | In-memory store, nothing persisted. The admin UI shows a warning pill. Fine for local work, never for production. |
| `RESEND_API_KEY` / `NEWSLETTER_FROM` | Signups are recorded as pending, no mail goes out, sending returns 503 with a clear message. |
| `ANTHROPIC_API_KEY` | The Claude tab reports itself off. Writing and sending are unaffected. |
| `ADMIN_PASSWORD` | `/admin` cannot be entered at all. The public site is unaffected. |

The landing page keeps serving in every one of those cases. That is
deliberate: the front page must not depend on the newsletter.

### DNS, which is Erik's step

Resend needs SPF and DKIM records on `strongtechnicalconsulting.com` before it
will send as that domain, and a DMARC record is worth adding at the same time.
Resend's dashboard prints the exact records when the domain is added. Until
those records resolve, mail either does not send or lands in spam.

This is the same class of step as the Cloud Run domain mappings: the records go
in at the registrar by hand.
