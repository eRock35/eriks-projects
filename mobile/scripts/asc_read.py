#!/usr/bin/env python3
"""Read-only App Store Connect calls, and the build's early check.

    python3 scripts/asc_read.py preflight

Every request in this file is a GET; there is no other method here, and
scripts/check.py fails if one appears. The token is asc_signing.token(): the
same key, the same JWT, no second signer. Nothing here prints the key, the
token, the key id or the issuer id, and Apple's own error text is cut down
(addresses removed, length capped) before anything is printed.

`preflight` runs in ios.yml's `plan` job, on ubuntu, before any macOS minute
is spent. It asks for one app and one certificate:

  401                      the key is wrong or revoked: stop.
  403 naming the agreement the Account Holder must accept Apple's updated
                           Program License Agreement: stop.
  any other 403            the key may not reach these resources: stop.
  anything else            Apple did not answer (a network error, a 5xx):
                           warn and carry on. The macOS jobs meet the same
                           Apple and say more; this check saves minutes, it
                           is not a gate on Apple's uptime.

What it cannot promise, said plainly: on 2026-11-01 Apple refused a WRITE
(POST /certificates) with "PLA Update available". Nobody has yet seen whether
it refuses these READS as well; it may refuse only writes. So passing reads
do not prove the agreement is accepted, and the step says exactly that.
Running ios.yml with check_only (Actions > Run workflow) is how to find out.

Also used by scripts/pulse.py, read-only, for the TestFlight state.
"""
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import asc_signing  # noqa: E402  (same key, same token)

# Apple's 403 for an unaccepted agreement says "PLA Update available ... must
# agree to the latest Program License Agreement"; App Store Connect's own is
# FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED. Either names it.
AGREEMENT = re.compile(r'agreement|\bPLA\b', re.I)
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
JWTISH = re.compile(r'eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}')

# Replaced by the tests; urllib.request.urlopen everywhere else.
OPEN = urllib.request.urlopen


class AscError(Exception):
    """An App Store Connect GET that did not return 2xx. `status` is 0 when
    Apple was never reached. `text` is Apple's error, already scrubbed."""

    def __init__(self, status, text):
        super().__init__(f'{status}: {text}' if status else text)
        self.status = status
        self.text = text


def scrub(text, limit=300):
    """Apple's words, safe to print in a public log: no addresses, nothing
    shaped like a token, no control characters, at most `limit` characters."""
    text = EMAIL.sub('[address]', str(text or ''))
    text = JWTISH.sub('[token]', text)
    text = re.sub(r'[\x00-\x1f\x7f]+', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:limit]


def _errors(raw):
    try:
        errs = json.loads(raw).get('errors', [])
        return '; '.join(f"{x.get('title')}: {x.get('detail')}" for x in errs) or raw
    except (ValueError, AttributeError):
        return raw


def get(path, timeout=30):
    """GET one App Store Connect resource; the parsed JSON, or AscError."""
    req = urllib.request.Request(
        asc_signing.API + path, method='GET',
        headers={'Authorization': 'Bearer ' + asc_signing.token(), 'Accept': 'application/json'})
    try:
        with OPEN(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise AscError(e.code, scrub(_errors(e.read().decode(errors='replace')))) from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise AscError(0, scrub(type(e).__name__)) from None


def classify(status, text):
    """'agreement' | 'auth' (401) | 'forbidden' (another 403) | 'error'."""
    if status == 403 and AGREEMENT.search(text or ''):
        return 'agreement'
    if status == 401:
        return 'auth'
    if status == 403:
        return 'forbidden'
    return 'error'


AGREEMENT_MSG = ('The Account Holder must accept the updated Apple Developer Program License '
                 'Agreement at developer.apple.com, then re-run.')
PASSED_MSG = ('Read-only checks passed: App Store Connect accepted the key for GET /apps and '
              'GET /certificates. An unaccepted agreement may still stop signing: Apple has only '
              'been seen refusing a write (POST /certificates), not these reads.')
CHECKS = (('/apps?limit=1', 'apps'), ('/certificates?limit=1', 'certificates'))


def _summary(line):
    out = os.environ.get('GITHUB_STEP_SUMMARY')
    if out:
        with open(out, 'a') as f:
            f.write(line + '\n')


def preflight():
    """0 when the build may go on, 1 when it should stop here."""
    for path, what in CHECKS:
        try:
            get(path)
        except AscError as e:
            reason = classify(e.status, e.text)
            if reason == 'agreement':
                print(f'::error title=Apple agreement::{AGREEMENT_MSG}')
                _summary(f'**Stopped before any macOS build:** {AGREEMENT_MSG}')
                return 1
            if reason == 'auth':
                msg = ('App Store Connect answered 401 to a read-only request: the API key is wrong '
                       'or revoked. Check APPSTORE_KEY_ID, APPSTORE_ISSUER_ID and APPSTORE_KEY_P8 '
                       '(mobile/README.md, steps (d) and (e)).')
                print(f'::error title=App Store Connect key refused::{msg}')
                _summary(f'**Stopped before any macOS build:** {msg}')
                return 1
            if reason == 'forbidden':
                msg = (f'App Store Connect answered 403 to GET {what}: {e.text or "no detail"}. '
                       'The key may not have access; the build needs an Admin key (mobile/README.md, step (d)).')
                print(f'::error title=App Store Connect access refused::{msg}')
                _summary(f'**Stopped before any macOS build:** {msg}')
                return 1
            print(f'::warning title=App Store Connect::GET {what} did not answer '
                  f'({e.status or "no response"}: {e.text or "no detail"}). Not stopping the build '
                  'for that; the macOS jobs will say more.')
            return 0
        except Exception as e:  # noqa: BLE001 - signing the token itself failed
            msg = (f'Could not sign an App Store Connect token from APPSTORE_KEY_P8 ({type(e).__name__}). '
                   'Paste the whole .p8 file, BEGIN and END lines included (mobile/README.md, step (e)).')
            print(f'::error title=APPSTORE_KEY_P8::{msg}')
            return 1
    print(f'::notice title=App Store Connect (read-only)::{PASSED_MSG}')
    _summary(PASSED_MSG)
    return 0


if __name__ == '__main__':
    if sys.argv[1:] == ['preflight']:
        sys.exit(preflight())
    print('::error title=Usage::asc_read.py preflight')
    sys.exit(2)
