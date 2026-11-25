#!/usr/bin/env bash
# App-Stack Kit: the one-line start.
#
#   curl -fsSL https://strongtechnicalconsulting.com/kits/install.sh | bash -s -- lk_your_licence_key
#
# or, to be asked for the key (it is not shown as you type):
#
#   curl -fsSL https://strongtechnicalconsulting.com/kits/install.sh | bash
#
# What it does: checks the licence, downloads the kit with a short-lived
# link from the same site, unpacks it into ./app-stack-kit, and runs
# ./setup.sh there. Anything after the key is handed to setup.sh (for
# example --advanced).
#
# Works in Google Cloud Shell as it is, and on a Mac or Linux machine that
# has curl, unzip, Node.js 20+ and gcloud.
#
# The licence key is never printed, never written to disk by this script,
# and never put on a command line by it: requests are sent with
# `curl --config -`, so the key travels on stdin.
set -euo pipefail

SERVER="${KIT_LICENSE_SERVER:-https://strongtechnicalconsulting.com}"
SLUG="app-stack"
DIR="${KIT_DIR:-app-stack-kit}"
# Questions are asked on the terminal: stdin is this script when it is piped
# from curl.
TTY="${KIT_TTY:-/dev/tty}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok: %s\n' "$*"; }
skip() { printf 'skip: %s (already done)\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
tty_ok() { { : < "$TTY"; } 2>/dev/null; }

cq() { # quote a value for a curl config line
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

HTTP_STATUS=000
HTTP_BODY=''
post_json() { # post_json URL JSON-BODY  -> HTTP_STATUS, HTTP_BODY
  local out
  if out="$(printf 'globoff\nrequest = "POST"\nurl = "%s"\nheader = "Content-Type: application/json"\ndata = "%s"\n' "$(cq "$1")" "$(cq "$2")" \
           | curl -sS --max-time 60 -w '\n%{http_code}' --config - 2>/dev/null)"; then
    HTTP_STATUS="${out##*$'\n'}"
    HTTP_BODY="${out%$'\n'*}"
    [ "$HTTP_BODY" != "$out" ] || HTTP_BODY=''
  else
    HTTP_STATUS=000
    HTTP_BODY=''
  fi
}

field() { # field NAME  (JSON on stdin) -> the value of a top-level field
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let j;
      try { j = JSON.parse(s); } catch (e) { return; }
      const v = j && j[process.argv[1]];
      if (v !== undefined && v !== null && typeof v !== "object") process.stdout.write(String(v));
    });' "$1"
}

refused() { # refused "doing what": explain HTTP_STATUS / HTTP_BODY and stop
  local reason renew
  reason="$(printf '%s' "$HTTP_BODY" | field reason)" || reason=''
  renew="$(printf '%s' "$HTTP_BODY" | field renew)" || renew=''
  case "$HTTP_STATUS:$reason" in
    000:*) die "Could not reach $SERVER while $1. Check your internet connection and run this again. Nothing was changed." ;;
    403:revoked) die "This licence was revoked (a refund or a dispute), so the kit cannot be downloaded with it. Nothing was changed." ;;
    403:updates-lapsed) die "Downloads for this licence have ended. Renew to download the kit again${renew:+: $renew} Nothing was changed." ;;
    403:*) die "That licence key was not recognised for the App-Stack Kit. Check it against your purchase email (it starts with lk_). Nothing was changed." ;;
    429:*) die "Too many tries from this network. Wait 15 minutes and run this again. Nothing was changed." ;;
    503:downloads-unavailable) die "The download is not available at this moment. Try again in a few minutes, or use the link in your purchase email. Nothing was changed." ;;
    *) die "The kit's site is not answering properly right now (HTTP $HTTP_STATUS while $1). Try again in a few minutes. Nothing was changed." ;;
  esac
}

main() {
  local key="${1:-${KIT_LICENSE_KEY:-}}" body tier link want got tmp new cloud=no
  if [ $# -gt 0 ]; then shift; fi

  say "App-Stack Kit installer"
  if [ "${CLOUD_SHELL:-}" = "true" ] || [ -n "${DEVSHELL_PROJECT_ID:-}" ] || [ -d /google/devshell ]; then
    cloud=yes
    say "  Google Cloud Shell: everything this needs is already here."
  fi

  # --- tools
  have curl || die "curl is missing. Install it and run this again."
  if ! have node; then
    die "Node.js is missing. The easiest way round that is Google Cloud Shell, which has everything: https://shell.cloud.google.com/?show=terminal . Or install Node.js 20 or newer from https://nodejs.org/ and run this again."
  fi
  if ! have unzip; then
    die "unzip is missing. Install it (Debian/Ubuntu: sudo apt-get install unzip) and run this again."
  fi

  # --- already here?
  if [ -f "$DIR/setup.sh" ]; then
    skip "download: the kit is in ./$DIR"
    if [ -n "$key" ]; then export KIT_LICENSE_KEY="$key"; fi
    run_setup "$@"
    return $?
  fi
  [ ! -e "$DIR" ] || die "There is already something called ./$DIR here and it is not the kit. Move it away, or run this from another folder. Nothing was changed."

  # --- the licence key
  if [ -z "$key" ]; then
    if tty_ok; then
      say ""
      say "Your licence key"
      say "  It is in your purchase email and starts with lk_."
      read -r -s -p "  (hidden as you paste it) > " key < "$TTY" || key=''
      printf '\n'
    else
      die "No licence key. Put it after the command:  ... | bash -s -- lk_your_key"
    fi
  fi
  key="$(printf '%s' "$key" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  printf '%s' "$key" | grep -Eq '^lk_[a-z2-7]{32}$' \
    || die "That does not look like a licence key. It is lk_ followed by 32 letters and digits; copy it from the purchase email with no spaces. Nothing was changed."
  export KIT_LICENSE_KEY="$key"

  # --- is the licence good, and for which edition?
  body="$(node -e 'process.stdout.write(JSON.stringify({ key: process.env.KIT_LICENSE_KEY, kit: process.argv[1], purpose: "setup" }))' "$SLUG")"
  post_json "$SERVER/api/kits/license/check" "$body"
  [ "$HTTP_STATUS" = "200" ] || refused "checking the licence"
  tier="$(printf '%s' "$HTTP_BODY" | field tier)" || tier=''
  [ -n "$tier" ] || die "The licence service gave an answer this installer does not understand. Try again in a few minutes. Nothing was changed."
  ok "licence accepted"

  # --- a short-lived link, from this site only
  body="$(node -e 'process.stdout.write(JSON.stringify({ key: process.env.KIT_LICENSE_KEY, kit: process.argv[1] }))' "$SLUG")"
  post_json "$SERVER/api/kits/license/download" "$body"
  [ "$HTTP_STATUS" = "200" ] || refused "asking for the download"
  link="$(printf '%s' "$HTTP_BODY" | field url)" || link=''
  want="$(printf '%s' "$HTTP_BODY" | field sha256)" || want=''
  body=''
  case "$link" in
    "$SERVER"/kits/download\?t=*) ;;
    *) die "The download service gave an address this installer does not trust. Nothing was changed." ;;
  esac

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/kit-install.XXXXXX")"
  # shellcheck disable=SC2064  # expand now: tmp is local
  trap "rm -rf '$tmp'" EXIT
  printf 'globoff\nurl = "%s"\noutput = "%s"\n' "$(cq "$link")" "$(cq "$tmp/kit.zip")" \
    | curl -sS -f --max-time 300 --config - \
    || die "The download failed. Nothing was changed; run this again."

  # --- is it what the site said it would be?
  if [ -n "$want" ]; then
    printf '%s' "$want" | grep -Eq '^[0-9a-f]{64}$' || die "The download service sent a checksum this installer does not understand. Nothing was changed."
    got="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$tmp/kit.zip")"
    [ "$got" = "$want" ] || die "The download does not match its checksum (it was cut short or changed on the way). Nothing was changed; run this again."
    ok "download checked (sha256)"
  fi
  unzip -q "$tmp/kit.zip" -d "$tmp/new" 2>/dev/null || die "The downloaded file is not a zip archive. Nothing was changed; run this again."
  new="$tmp/new/app-stack-kit"
  { [ -f "$new/VERSION" ] && [ -d "$new/scripts" ] && [ -d "$new/app" ]; } \
    || die "The downloaded archive is not an App-Stack Kit. Nothing was changed."
  mv "$new" "$DIR"
  rm -rf "$tmp"
  trap - EXIT
  ok "App-Stack Kit $(tr -d ' \n\r' < "$DIR/VERSION") unpacked into ./$DIR"

  if [ ! -f "$DIR/setup.sh" ]; then
    # The Scripts-only edition has no guided installer.
    say ""
    say "Your licence is for the Scripts-only edition ($tier): the scripts are in ./$DIR."
    say "Read ./$DIR/README.md and run them in order."
    return 0
  fi
  run_setup "$@"
}

run_setup() {
  say ""
  cd "$DIR"
  if [ "${cloud:-no}" = "yes" ]; then
    say "Next time, come back with:  cd $DIR && ./setup.sh"
  fi
  # setup.sh asks its questions on stdin; give it the terminal, not the pipe
  # this script arrived on.
  if tty_ok && [ ! -t 0 ]; then
    exec bash ./setup.sh "$@" < "$TTY"
  fi
  exec bash ./setup.sh "$@"
}

# Everything above is only defined. Nothing runs until the whole script has
# arrived, so a download cut off half way does nothing at all.
main "$@"
