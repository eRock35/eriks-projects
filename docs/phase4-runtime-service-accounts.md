# Runtime service accounts — done 2026-09-21

Every Cloud Run service now runs as its own account. Before this, all seven ran
as `cover-sheet-deployer@` — the account that builds images, pushes to
Artifact Registry and rewrites Cloud Run specs. The DataViz container, which
takes pasted data from strangers, held the credentials to redeploy the
vacation app.

| Service | Runs as | Firestore | Secrets |
|---|---|---|---|
| `dataviz` | `dataviz-run` | `dataviz`, `identity` | 6 |
| `friction` | `friction-run` | `friction`, `identity` | 6 |
| `hopscotch` | `hopscotch-run` | `hopscotch` | 3 |
| `college-football-app` | `football-run` | `college-football-app`, `identity` | 7 |
| `trip-planner` | `trip-planner-run` | `trip-planner`, `identity` | 6 |
| `santa-rosa-beach-trip` | `vacation-run` | `santa-rosa-beach-trip` | 4 |
| `landing-page` | `landing-run` | **all** — see below | 7 |

Each account holds `roles/logging.logWriter`, `roles/datastore.user`
**conditioned to its own databases**, and `roles/secretmanager.secretAccessor`
on each secret that service actually mounts — nothing else. No deploy rights,
no Cloud Build, no Artifact Registry, no blanket Secret Manager.

## The database conditions really work

`roles/datastore.user` is a project-level role, so scoping it needs an IAM
condition — and a condition that is syntactically valid but never matches
would silently deny, which is the kind of thing you find out by taking an app
down. So it was tested before any live service moved: the deployer was given
`tokenCreator` on each new account, impersonated it, and asked Firestore
directly.

```
dataviz-run       dataviz=OK  identity=OK  [santa-rosa-beach-trip]=blocked
friction-run      friction=OK identity=OK  [santa-rosa-beach-trip]=blocked
hopscotch-run     hopscotch=OK            [identity]=blocked
football-run      college-football-app=OK identity=OK [santa-rosa-beach-trip]=blocked
trip-planner-run  trip-planner=OK identity=OK [santa-rosa-beach-trip]=blocked
vacation-run      santa-rosa-beach-trip=OK [identity]=blocked
landing-run       eriks-projects=OK identity=OK dataviz=OK
```

Secrets were checked the same way: `dataviz-run` reads
`dataviz-session-secret` and is refused `vacation-login-password`;
`vacation-run` the reverse. `tokenCreator` was removed afterwards — it existed
only for that test.

**`landing-page` is the exception and stays broad.** `lib/digest.js` composes
the weekly roundup by reading every app's database and `lib/uptime.js` probes
every app, so scoping it would break the digest. Six of seven are narrowed;
the seventh is not. If that ever matters more than the digest does, the fix is
to have each app expose its own counts behind the cron key rather than letting
the landing page read its way in.

## What it was verified against

Cloud Run reports a revision ready only after it resolves every secret env
var, so seven `CONDITION_SUCCEEDED` revisions prove the secret bindings. The
rest was checked live:

- `trip-planner-check-watches` forced → `control/watch-cron` rewritten at
  15:08:32 by `trip-planner-run`. That is a **write** through a conditioned
  binding, not just a read.
- `cfb-batch-collect` forced → 2xx. It returns `{skipped: "nothing pending"}`
  without writing, so `control/status` stays where it was; the 2xx is the
  proof that `football-run` read Firestore.
- `landing-notify` forced → all seven apps probed from inside Cloud Run,
  **HTTP 200 each**, twice: once after the swaps and once after Owner was
  revoked.
- Cloud Logging, severity ≥ WARNING since the swap: no permission failures on
  any service. The only warnings were bots probing `/functionRouter` and
  `/api/templates/preview` on the landing page and getting 404s, which is
  ordinary background noise.

## The Owner grant is gone

Creating accounts and binding roles needs a project Owner, which the deployer
was not. Erik granted it Owner for that one job. It has been **revoked** —
`roles/owner` on this project is `user:strongtechnicalconsulting@gmail.com`
and nothing else, confirmed against the live policy, and
`iam.serviceAccounts.create` and `resourcemanager.projects.setIamPolicy` both
read back denied once IAM propagated.

Two changes to the deployer survive on purpose:

- `roles/iam.serviceAccountUser` on each of the seven new accounts. Without it
  the deployer cannot ship a service that runs as one of them.
- `roles/logging.viewer`, added on the way out. Reading this project's logs had
  been a 403 for the deployer all along — `college-football-app/server.js`
  carries a comment about working around exactly that — and it is read-only.

**The deployer is still a powerful account** (`run.admin`, `datastore.owner`,
`secretmanager.admin`, `storage.admin` and more). Phase 4 did not change that
and was not meant to. What changed is that no app container runs as it any
more, so a bug in an app is no longer a path to the deploy pipeline.

## Rolling back

One field per service. `scripts/phase4-service-accounts.sh` documents the
bindings; to put a service back:

```
PATCH run.googleapis.com/v2/…/services/<svc>
  template.serviceAccount = cover-sheet-deployer@metal-celerity-236019.iam.gserviceaccount.com
```

The pre-swap revision is also still there to route traffic back to.

## Later bindings

The table above is the state on 2026-09-21. Secrets bound since, read back from
Secret Manager's own IAM policies rather than from memory:

| Date | Account | Added | Why |
|---|---|---|---|
| 2026-09-22 | `trip-planner-run` | `stripe-secret-key`, `stripe-member-price` | Credit and membership are sold from inside the app |
| 2026-09-22 | `vacation-run` | `vacation-gmail-token-key` | Seals the vacation app's Gmail token. Its **own** key, bound to nothing else — the public apps share `byok-encryption-key`, and this app's rule is that no other service can read its data |
| 2026-09-23 | `trip-planner-run`, `vacation-run` | `google-oauth-client-id`, `google-oauth-client-secret` | Gmail booking import. One OAuth client, two redirect URIs, testing mode |

As of 2026-09-23: `trip-planner-run` reads 10 secrets, `vacation-run` reads 7.
`vacation-run` still reads nothing any other app can use to reach its data, and
its datastore condition is unchanged — the OAuth client is shared, but a client
ID and secret open nothing without a user's own consent at Google.
