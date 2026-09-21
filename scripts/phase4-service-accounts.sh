#!/usr/bin/env bash
#
# Phase 4, step one: create a runtime service account per Cloud Run service and
# grant it only what that service uses.
#
# Run this in Cloud Shell as a project Owner. The sandbox cannot: the deployer
# key it holds has no IAM-administration rights (see
# docs/phase4-runtime-service-accounts.md for the probe output).
#
# Safe to re-run. It creates accounts and adds bindings; it does NOT touch any
# Cloud Run service, so nothing can go down while it runs. Swapping each
# service over to its new identity is a separate, reversible step.
set -euo pipefail

PROJECT="${PROJECT:-metal-celerity-236019}"
DRY="${DRY_RUN:-0}"

run() {
  if [[ "$DRY" == "1" ]]; then echo "  would: $*"; else "$@"; fi
}

# service | account id | comma-separated Firestore databases | space-separated secrets
#
# landing-page reads every app's database (lib/digest.js), so it gets an
# unconditioned datastore.user - see the runbook for why and what it costs.
APPS=(
"dataviz|dataviz-run|dataviz,identity|anthropic-api-key byok-encryption-key dataviz-session-secret dataviz-stripe-secret-key dataviz-stripe-webhook-secret identity-session-secret"
"friction|friction-run|friction,identity|anthropic-api-key byok-encryption-key friction-app-password friction-cron-secret friction-session-secret identity-session-secret"
"hopscotch|hopscotch-run|hopscotch|anthropic-api-key cron-secret hopscotch-jwt-secret"
"college-football-app|football-run|college-football-app,identity|anthropic-api-key byok-encryption-key cfb-session-secret cron-secret identity-session-secret site-login-password site-login-username"
"trip-planner|trip-planner-run|trip-planner,identity|anthropic-api-key byok-encryption-key identity-session-secret trip-planner-admin-email trip-planner-cron-secret trip-planner-session-secret"
"santa-rosa-beach-trip|vacation-run|santa-rosa-beach-trip|anthropic-api-key vacation-login-password vacation-login-username vacation-session-secret"
"landing-page|landing-run|ALL|anthropic-api-key byok-encryption-key cron-secret identity-session-secret landing-admin-password landing-session-secret resend-api-key"
)

for row in "${APPS[@]}"; do
  IFS='|' read -r service account dbs secrets <<<"$row"
  member="serviceAccount:${account}@${PROJECT}.iam.gserviceaccount.com"
  echo "== ${service} -> ${account}"

  if gcloud iam service-accounts describe "${account}@${PROJECT}.iam.gserviceaccount.com" \
       --project "$PROJECT" >/dev/null 2>&1; then
    echo "  account exists"
  else
    run gcloud iam service-accounts create "$account" --project "$PROJECT" \
      --display-name "${service} runtime"
  fi

  # Every runtime account writes its own logs.
  run gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "$member" --role roles/logging.logWriter --condition=None --quiet

  # Firestore. Project-level role, so scope it with a condition where we can.
  if [[ "$dbs" == "ALL" ]]; then
    echo "  datastore.user, unconditioned (this one reads every database)"
    run gcloud projects add-iam-policy-binding "$PROJECT" \
      --member "$member" --role roles/datastore.user --condition=None --quiet
  else
    expr=""
    IFS=',' read -ra list <<<"$dbs"
    for db in "${list[@]}"; do
      [[ -n "$expr" ]] && expr="${expr} || "
      expr="${expr}resource.name == \"projects/${PROJECT}/databases/${db}\""
    done
    if ! run gcloud projects add-iam-policy-binding "$PROJECT" \
           --member "$member" --role roles/datastore.user --quiet \
           --condition="title=${account}-dbs,expression=${expr}"; then
      echo "  !! the condition was rejected; falling back to unconditioned"
      echo "  !! (still no deploy rights, no Cloud Build, no blanket secrets)"
      run gcloud projects add-iam-policy-binding "$PROJECT" \
        --member "$member" --role roles/datastore.user --condition=None --quiet
    fi
  fi

  # Secrets, one binding per secret - exact, and no condition needed.
  for secret in $secrets; do
    run gcloud secrets add-iam-policy-binding "$secret" --project "$PROJECT" \
      --member "$member" --role roles/secretmanager.secretAccessor --quiet
  done

  # The deployer must be able to hand a service this identity.
  run gcloud iam service-accounts add-iam-policy-binding \
    "${account}@${PROJECT}.iam.gserviceaccount.com" --project "$PROJECT" \
    --member "serviceAccount:cover-sheet-deployer@${PROJECT}.iam.gserviceaccount.com" \
    --role roles/iam.serviceAccountUser --quiet
done

cat <<'DONE'

Accounts and bindings are in place. No Cloud Run service was touched.

Tell Claude, and it will swap each service over one at a time - least critical
first - checking each revision before moving on. It cannot reach *.run.app from
its sandbox, so it will ask you to open an app (or run the cron verify) after
each swap.

Verify a scoped binding actually carries its condition:
  gcloud projects get-iam-policy metal-celerity-236019 \
    --flatten="bindings[].members" --format="table(bindings.role,bindings.condition.title)" \
    --filter="bindings.members:dataviz-run@"
DONE
