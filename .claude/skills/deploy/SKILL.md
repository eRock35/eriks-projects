---
name: deploy
description: Deploy Erik's apps (college football, trip planner, vacation, landing page) to Google Cloud Run in project metal-celerity-236019. Use whenever a change needs to go live, a deploy needs verifying, or someone asks what is currently running. Covers the no-gcloud/no-Docker REST pipeline and the gcpdeploy tool.
---

# Deploying Erik's apps

Everything runs on Cloud Run in GCP project `metal-celerity-236019`, region
`us-central1`. Use the `gcpdeploy` script in this skill's directory — don't
hand-roll `curl` calls unless the script genuinely can't do what's needed.

```
./gcpdeploy status          # what's running: services, cron jobs, databases
./gcpdeploy ship <app>      # build the checked-out repo and deploy it
./gcpdeploy verify <app>    # force the cron job, read back what it wrote
./gcpdeploy page            # upload the landing page
./gcpdeploy auth            # re-mint the token (ship/verify do this for you)
```

Apps: `football`, `trip`, `vacation`, `spellbook`. (`beer` is registered but
deliberately refuses — see **Hopscotch** below.)

An app may live in a **subdirectory** of its repo rather than at a repo root:
give its `apps.json` entry a `subdir` key and `ship` packages only that subtree,
so two services in one repo never share a build context. Nothing uses that today
— Spellbook did until it got its own repo on 2026-09-22 — but the mechanism is
there and tested if a second app ever shares a repository.

## The environment constraints that shape all of this

- **No `gcloud`.** `sdk.cloud.google.com` is blocked by the egress policy.
- **No local Docker.** Images build in Cloud Build.
- **No outbound HTTP to the apps.** The proxy blocks `*.run.app` and the custom
  domains. You **cannot** curl a deployed app to check it.

A `403` or `407` from the proxy is a policy decision, not a flake. Never try to
route around it.

Because you can't curl the apps, "it deployed" is not the same as "it works."
Finish with `gcpdeploy verify` where the app has a cron job, and otherwise ask
Erik to open it in a browser. Say plainly which of the two you did.

## Credentials

`ship` and `verify` mint a token automatically. The token lasts an hour and is
cached; re-mint rather than debugging a stale-token 401.

**The service account key does not survive a new container.** If `gcpdeploy`
reports it can't find one, ask Erik to re-upload it. Don't improvise
credentials, and don't move the key into the environment's plain "Environment
variables" box — that field is unencrypted, and Erik has already been told so.

## What `ship` actually does

1. Refuses if the repo has uncommitted changes — a deployed image that matches
   no commit isn't reproducible.
2. Tars the repo (minus `.git` and `node_modules`), uploads to the build bucket.
3. Cloud Build builds the Dockerfile, tagged with the short commit sha.
4. **Reads the live Cloud Run service and swaps only the image digest**, then
   PATCHes it back.
5. Polls until the revision reports `CONDITION_SUCCEEDED`.

Step 4 is the important one. Env vars, secrets, scaling and the service account
are never reconstructed from a config file, so a stale config can't silently
drop a secret from production. **Keep it that way** — if you add a feature,
don't start declaring env vars in `apps.json`.

Two things that have bitten this project before:

- **Always pin the digest.** A floating `:latest` tag does not create a new
  revision, so the deploy silently no-ops.
- **Cloud Run service names are immutable.** Renaming means create-new plus
  delete-old, not an edit.

A revision reaching Ready is real evidence: Cloud Run fails the revision if a
referenced secret can't be read, so Ready means the secrets mounted and the
container bound its port.

## Verifying without HTTP

`gcpdeploy verify <app>` forces the app's Cloud Scheduler job and then reads the
Firestore doc that route writes. An **empty** `status` `{}` plus a fresh
`lastAttemptTime` means the app returned 2xx — which proves Cloud Run booted,
the cron secret matched, and the handler reached Firestore.

A job that has never run reports `code: -1`. That's the never-run initial
state, not a failure.

`vacation` has no cron job, so it has no automated verification. Ask Erik.

`spellbook`'s job is `spellbook-rollup`, writing `control/rollup`. It recomputes
time-decayed trending scores and snapshots the app leaderboard. Unlike
trip-planner's sweep it calls no model, so forcing it costs nothing — which
makes it a genuinely free end-to-end check.

## Firestore

Every app has its **own named** Native-mode database. **Never use `(default)`**
— on this project that's a legacy Datastore-mode database tied to App Engine.

## Secrets

Per-app credentials are deliberately **not** shared. The football app's login is
the kind of thing Erik might hand to a friend so they can run research; that
password must not also open the trip apps. If you add an app, give it its own
secrets. `anthropic-api-key` is the one intentionally shared value.

## Hopscotch (the beer app)

`gcpdeploy ship beer` refuses on purpose. It builds through its own
`cloudbuild.yaml` with a git-sha image tag, an `APP_VERSION` build arg, and a
separate `hopscotch` Artifact Registry repo rather than the shared
`erik-projects` one.

Its committed deploy tooling is also stale: `cloudbuild.yaml` and
`deploy/deploy.sh` both call `gcloud`, which doesn't exist here, and they name
two secrets that don't exist in this project (`hopscotch-anthropic-key`,
`hopscotch-cron-secret`) — the running service uses the shared
`anthropic-api-key` and `cron-secret`. Reconcile that before automating it;
until then, deploy Hopscotch by hand.

## Custom domains

`footballapp.` and `beer.` are mapped and live. **Don't add a mapping for the
vacation app.** A mapping publishes the hostname to public Certificate
Transparency logs, and that app holds family PII. See `DEPLOY.md` at the repo
root for the decision record.

## Known state

- Every service runs as the broad deployer account `cover-sheet-deployer@`
  rather than a scoped-down per-app identity. Fixing it needs
  `roles/iam.serviceAccountAdmin`, which the deployer lacks. **Do not
  self-grant IAM** — ask Erik.
- An empty `cover-sheet` Firestore database in `us-east4` still exists;
  deleting it was blocked by a safety classifier. Harmless.

`DEPLOY.md` at the repo root has the longer-form reference, including the raw
REST shapes if you ever need to work outside the script.
