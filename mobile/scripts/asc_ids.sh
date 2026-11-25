#!/usr/bin/env bash
# Clean the App Store Connect key ID and issuer ID once per job, so every
# later step (asc_read.py, asc_signing.py, xcodebuild's
# -authenticationKeyID / -authenticationKeyIssuerID) sees the same values.
#
# Reads RAW_KEY_ID and RAW_ISSUER_ID (the secrets as pasted), removes every
# space, tab and line break, checks the shape, masks the cleaned values in
# the log and writes APPSTORE_KEY_ID / APPSTORE_ISSUER_ID to $GITHUB_ENV.
# Never prints either value.
#
# The job must NOT also set APPSTORE_KEY_ID / APPSTORE_ISSUER_ID under `env:`:
# a job- or step-level `env:` wins over $GITHUB_ENV and would bring the
# untrimmed secret back.
set -euo pipefail

key_id=$(printf '%s' "${RAW_KEY_ID:-}" | tr -d ' \t\r\n')
issuer=$(printf '%s' "${RAW_ISSUER_ID:-}" | tr -d ' \t\r\n')

if [ "$key_id" != "${RAW_KEY_ID:-}" ]; then
  echo "::warning title=APPSTORE_KEY_ID::The secret has spaces or line breaks around it; they were removed for this run. Re-paste it as the 10 characters only."
fi
if [ "$issuer" != "${RAW_ISSUER_ID:-}" ]; then
  echo "::warning title=APPSTORE_ISSUER_ID::The secret has spaces or line breaks around it; they were removed for this run. Re-paste it as the ID only."
fi

if ! printf '%s' "$key_id" | grep -Eq '^[A-Z0-9]{10}$'; then
  echo "::error title=APPSTORE_KEY_ID::It should be the key's 10-character Key ID (capital letters and digits) from App Store Connect > Users and Access > Integrations > App Store Connect API."
  exit 1
fi
if ! printf '%s' "$issuer" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  echo "::error title=APPSTORE_ISSUER_ID::It should be the Issuer ID shown above the Team Keys list (a UUID like 69a6de70-...). An Individual key has no issuer and cannot be used here."
  exit 1
fi

echo "::add-mask::$key_id"
echo "::add-mask::$issuer"
{
  echo "APPSTORE_KEY_ID=$key_id"
  echo "APPSTORE_ISSUER_ID=$issuer"
} >> "$GITHUB_ENV"
