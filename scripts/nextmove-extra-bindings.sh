#!/usr/bin/env bash
#
# Next Move's IAM beyond the standard app shape - Erik runs this in Cloud
# Shell as a project Owner. Nothing runs it automatically, and the deployer
# key the sandbox holds cannot (it has no IAM-admin rights, on purpose).
#
#   ./scripts/new-app-accounts.sh nextmove     # first: the standard account
#   ./scripts/nextmove-extra-bindings.sh       # then this, once
#   ... Claude creates the service and the three Cloud Run jobs ...
#   ./scripts/nextmove-extra-bindings.sh       # again: binds run.invoker on the jobs
#
# What it does, all additive and safe to re-run:
#   1. enables the BigQuery API and creates dataset `nextmove` in us-central1
#      (the deployer may not hold bigquery.datasets.create);
#   2. roles/bigquery.jobUser on the project for nextmove-run@ - to run
#      queries and load jobs (jobs are project-level; there is no narrower
#      grant);
#   3. roles/bigquery.dataEditor on dataset `nextmove` ONLY for nextmove-run@
#      - read, write, create and drop tables there, nowhere else;
#   4. roles/run.invoker on each Next Move Cloud Run job for nextmove-run@,
#      which Cloud Scheduler uses as its OAuth identity to call jobs:run.
#      A job that does not exist yet is skipped with a note - run this again
#      after the jobs are created.
#
# Secrets: none beyond the standard two (anthropic-api-key,
# identity-session-secret), which new-app-accounts.sh binds. SEC_USER_AGENT
# is a plain env var on the jobs (a contact line, not a secret).
set -euo pipefail

PROJECT="${PROJECT:-metal-celerity-236019}"
REGION="${REGION:-us-central1}"
DATASET="${DATASET:-nextmove}"
ACCOUNT="nextmove-run@${PROJECT}.iam.gserviceaccount.com"
MEMBER="serviceAccount:${ACCOUNT}"
JOBS="nextmove-daily nextmove-weekly nextmove-comp"

gcloud iam service-accounts describe "$ACCOUNT" --project "$PROJECT" >/dev/null 2>&1 \
  || { echo "nextmove-run@ does not exist yet - run ./scripts/new-app-accounts.sh nextmove first"; exit 1; }

echo "== BigQuery API and dataset ${DATASET} (${REGION})"
gcloud services enable bigquery.googleapis.com --project "$PROJECT" >/dev/null
if bq --project_id="$PROJECT" show --format=none "${PROJECT}:${DATASET}" >/dev/null 2>&1; then
  echo "  dataset exists"
else
  bq --project_id="$PROJECT" --location="$REGION" mk --dataset \
    --description "Next Move: postings, public comp, company events, fit scores (keyed hashes only)" \
    "${PROJECT}:${DATASET}"
fi

echo "== bigquery.jobUser on the project"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "$MEMBER" --role roles/bigquery.jobUser --condition=None --quiet >/dev/null

echo "== bigquery.dataEditor on dataset ${DATASET} only"
policy="$(mktemp)"
bq --project_id="$PROJECT" get-iam-policy --format=prettyjson "${PROJECT}:${DATASET}" > "$policy"
python3 - "$policy" "$MEMBER" <<'PY'
import json, sys
path, member = sys.argv[1], sys.argv[2]
p = json.load(open(path))
role = 'roles/bigquery.dataEditor'
b = next((x for x in p.setdefault('bindings', []) if x.get('role') == role and not x.get('condition')), None)
if b is None:
    p['bindings'].append({'role': role, 'members': [member]})
elif member not in b['members']:
    b['members'].append(member)
json.dump(p, open(path, 'w'))
PY
bq --project_id="$PROJECT" set-iam-policy "${PROJECT}:${DATASET}" "$policy" >/dev/null
rm -f "$policy"

echo "== run.invoker on the jobs, for Cloud Scheduler"
for job in $JOBS; do
  if gcloud run jobs describe "$job" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
    gcloud run jobs add-iam-policy-binding "$job" --project "$PROJECT" --region "$REGION" \
      --member "$MEMBER" --role roles/run.invoker --quiet >/dev/null
    echo "  ${job}: bound"
  else
    echo "  ${job}: not created yet - run this script again once it exists"
  fi
done

echo
echo "Done. Tell Claude - it creates (or schedules) the rest from here."
