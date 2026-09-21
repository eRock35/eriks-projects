# Phase 4: give each service its own runtime identity

All seven Cloud Run services run as `cover-sheet-deployer@` — the same account
that builds images, pushes to Artifact Registry and rewrites Cloud Run specs.
So the DataViz container, which takes pasted data from strangers, holds the
credentials to redeploy the vacation app.

This is the fix. It is written down rather than done because the step that
starts it needs a project Owner, and this sandbox does not authenticate as one.

## Why Claude cannot start it

The sandbox authenticates with the uploaded key for
`cover-sheet-deployer@metal-celerity-236019.iam.gserviceaccount.com`. That
account can deploy, but holds no IAM-administration rights anywhere:

```
$ POST cloudresourcemanager…:testIamPermissions
  asked:   iam.serviceAccounts.create, resourcemanager.projects.setIamPolicy,
           resourcemanager.projects.getIamPolicy, iam.serviceAccounts.actAs,
           run.services.update
  granted: iam.serviceAccounts.actAs, run.services.update

$ POST cloudresourcemanager…:getIamPolicy
  403 "The caller does not have permission"

$ POST secretmanager…/secrets/ANTHROPIC_API_KEY:testIamPermissions
  asked:   secretmanager.secrets.setIamPolicy, secretmanager.secrets.getIamPolicy
  granted: {} — neither
```

An Owner can always read the project IAM policy. This account cannot, so it is
not one.

The split matters: **Claude already holds the half that swaps a service's
identity** (`run.services.update` + `iam.serviceAccounts.actAs`). What it
cannot do is create the accounts or grant them anything. Once the accounts
exist with their roles, Claude can do the rest and roll it back.

## Two ways forward

**A. Grant the deployer the two admin roles, and Claude does all of it.**

```bash
PROJECT=metal-celerity-236019
DEPLOYER=cover-sheet-deployer@$PROJECT.iam.gserviceaccount.com
for ROLE in roles/iam.serviceAccountAdmin roles/resourcemanager.projectIamAdmin; do
  gcloud projects add-iam-policy-binding $PROJECT \
    --member="serviceAccount:$DEPLOYER" --role="$ROLE"
done
```

Worth knowing what this trades: `projectIamAdmin` lets the holder grant itself
anything, so this makes the deployer key effectively Owner-equivalent — and
that key sits in a sandbox upload. It is the fastest path and a reasonable one
for a personal project, but it is the opposite direction from what Phase 4 is
for. Revoking both roles once the accounts exist gets the ratchet back.

**B. Run `scripts/phase4-service-accounts.sh` yourself in Cloud Shell**, then
tell Claude. It creates the seven accounts and their bindings and touches
nothing else — no Cloud Run service is modified, so nothing can break while
it runs. Claude then does the identity swap one service at a time.

B is the better shape: the privilege to hand out privilege never leaves your
own account.

## What each service actually needs

Collected from the live specs on 2026-09-21.

| Service | Firestore databases | Secrets |
|---|---|---|
| `dataviz` | `dataviz`, `identity` | `anthropic-api-key`, `byok-encryption-key`, `dataviz-session-secret`, `dataviz-stripe-secret-key`, `dataviz-stripe-webhook-secret`, `identity-session-secret` |
| `friction` | `friction`, `identity` | `anthropic-api-key`, `byok-encryption-key`, `friction-app-password`, `friction-cron-secret`, `friction-session-secret`, `identity-session-secret` |
| `landing-page` | **all of them** — see below | `anthropic-api-key`, `byok-encryption-key`, `cron-secret`, `identity-session-secret`, `landing-admin-password`, `landing-session-secret`, `resend-api-key` |
| `trip-planner` | `trip-planner`, `identity` | `anthropic-api-key`, `byok-encryption-key`, `identity-session-secret`, `trip-planner-admin-email`, `trip-planner-cron-secret`, `trip-planner-session-secret` |
| `hopscotch` | `hopscotch` | `anthropic-api-key`, `cron-secret`, `hopscotch-jwt-secret` |
| `santa-rosa-beach-trip` | `santa-rosa-beach-trip` | `anthropic-api-key`, `vacation-login-password`, `vacation-login-username`, `vacation-session-secret` |
| `college-football-app` | `college-football-app`, `identity` | `anthropic-api-key`, `byok-encryption-key`, `cfb-session-secret`, `cron-secret`, `site-login-password`, `site-login-username` |

**`landing-page` is the exception and stays broad.** `lib/digest.js` composes
the weekly roundup by reading every app's database, and `lib/uptime.js` probes
every app. Scoping it to one database would break the digest. That is a real
limit on what Phase 4 buys: six of seven services get narrowed, the seventh
keeps project-wide Firestore read. If that ever matters more than the digest
does, the fix is to have each app expose its own counts behind the cron key
rather than letting the landing page read its way in.

Secret access is granted **per secret**, which is exact and needs no
conditions. Firestore is the loose one: `roles/datastore.user` is a
project-level role, so the script attempts an IAM condition scoping each
binding to that service's databases. **Verify the condition took effect before
relying on it** — if conditions are rejected for this role, the fallback is
unconditioned `datastore.user`, which still removes deploy rights, Cloud Build
and blanket Secret Manager from every app container. That alone is most of the
win.

## The swap, and getting back

Changing a service's runtime identity creates a new revision from the same
image. Nothing is rebuilt.

Claude does them one at a time, least critical first — `dataviz`, `friction`,
`hopscotch`, `college-football-app`, `trip-planner`, `landing-page`,
`santa-rosa-beach-trip` — and stops at the first one that misbehaves. Because
this sandbox cannot reach `*.run.app`, "the revision went green" is not "the
app works": after each swap someone has to open it, or the app's cron
`verify` has to come back clean. Expect to be asked.

Rollback is one field: set `template.serviceAccount` back to
`cover-sheet-deployer@…` and PATCH. The previous revision is also still there
to route traffic back to.
