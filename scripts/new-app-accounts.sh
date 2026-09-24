#!/usr/bin/env bash
#
# Give a new app its own runtime service account - the one step of a first
# deploy the sandbox cannot do.
#
#   ./scripts/new-app-accounts.sh spar snapquote
#
# Run it in Cloud Shell as a project Owner. The deployer key the sandbox holds
# has no IAM-administration rights on purpose (docs/phase4-runtime-service-
# accounts.md), so creating an account and granting it roles is Erik's, every
# time. Everything else - the database, the image, the service - Claude does.
#
# For each app NAME it creates NAME-run@ and grants exactly what a standard
# app on this domain needs, the same shape as dataviz-run:
#   - logging.logWriter
#   - datastore.user, conditioned to the NAME and identity databases
#   - secretAccessor on anthropic-api-key and identity-session-secret
#   - serviceAccountUser for the deployer, so it can ship a service as NAME-run
#
# Safe to re-run: existing accounts are left alone and bindings are additive.
# An app that needs more secrets (Stripe, BYOK) gets them bound separately,
# when it needs them.
set -euo pipefail

PROJECT="${PROJECT:-metal-celerity-236019}"
DEPLOYER="cover-sheet-deployer@${PROJECT}.iam.gserviceaccount.com"
SECRETS="anthropic-api-key identity-session-secret"

[[ $# -gt 0 ]] || { echo "usage: $0 <app> [<app> ...]"; exit 1; }

for app in "$@"; do
  [[ "$app" =~ ^[a-z][a-z0-9-]{1,24}$ ]] || { echo "bad app name: $app"; exit 1; }
  account="${app}-run"
  email="${account}@${PROJECT}.iam.gserviceaccount.com"
  member="serviceAccount:${email}"
  echo "== ${app} -> ${account}"

  if gcloud iam service-accounts describe "$email" --project "$PROJECT" >/dev/null 2>&1; then
    echo "  account exists"
  else
    gcloud iam service-accounts create "$account" --project "$PROJECT" --display-name "${app} runtime"
  fi

  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "$member" --role roles/logging.logWriter --condition=None --quiet >/dev/null

  expr="resource.name == \"projects/${PROJECT}/databases/${app}\" || resource.name == \"projects/${PROJECT}/databases/identity\""
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "$member" --role roles/datastore.user --quiet \
    --condition="title=${account}-dbs,expression=${expr}" >/dev/null

  for secret in $SECRETS; do
    gcloud secrets add-iam-policy-binding "$secret" --project "$PROJECT" \
      --member "$member" --role roles/secretmanager.secretAccessor --quiet >/dev/null
  done

  gcloud iam service-accounts add-iam-policy-binding "$email" --project "$PROJECT" \
    --member "serviceAccount:${DEPLOYER}" --role roles/iam.serviceAccountUser --quiet >/dev/null

  echo "  done"
done

echo
echo "Accounts ready. Tell Claude - it creates the Cloud Run services from here."
