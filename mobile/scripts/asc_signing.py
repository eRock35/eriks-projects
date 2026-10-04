#!/usr/bin/env python3
"""App Store signing for one CI build, through the App Store Connect API.

Xcode's automatic signing wants a development profile before it will archive,
and Apple refuses one to a team with no registered devices. A TestFlight
upload never needs a device, so CI signs for distribution only:

  setup    make a key and CSR on the runner, ask Apple for a distribution
           certificate, put both in a throwaway keychain, make sure the bundle
           ID has Associated Domains, create an App Store profile for it,
           install the profile, and patch the App target to sign manually.
  cleanup  delete the profile and revoke the certificate.

This certificate signs the ARCHIVE only. Apple checks a build's signature
again when it is sent for review, and one signed with a revoked certificate
fails as ITMS-90035 "Invalid Signature" (Flight and Football, 2026-10-03). So
the workflow deletes this keychain before exporting, and the export re-signs
with Apple's cloud-managed distribution certificate, which is never revoked. Apple caps how
many distribution certificates a team may hold at once, which is why the
workflow builds one app at a time and always runs cleanup.

Needs: APPSTORE_KEY_ID, APPSTORE_ISSUER_ID, APPLE_TEAM_ID in the environment,
the key at $RUNNER_TEMP/AuthKey.p8, and pyjwt + cryptography.
"""
import base64
import json
import os
import pathlib
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = 'https://api.appstoreconnect.apple.com/v1'
TEMP = pathlib.Path(os.environ.get('RUNNER_TEMP', '/tmp'))
STATE = TEMP / 'asc-signing.json'
KEYCHAIN = TEMP / 'signing.keychain-db'


def die(title, msg):
    print(f'::error title={title}::{msg}')
    sys.exit(1)


def token():
    import jwt
    key = (TEMP / 'AuthKey.p8').read_text()
    now = int(time.time())
    return jwt.encode(
        {'iss': os.environ['APPSTORE_ISSUER_ID'], 'iat': now, 'exp': now + 900,
         'aud': 'appstoreconnect-v1'},
        key, algorithm='ES256',
        headers={'kid': os.environ['APPSTORE_KEY_ID'], 'typ': 'JWT'})


def api(method, path, body=None):
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + token(),
                 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')
        try:
            errs = json.loads(detail).get('errors', [])
            detail = '; '.join(f"{x.get('title')}: {x.get('detail')}" for x in errs) or detail
        except ValueError:
            pass
        raise RuntimeError(f'{method} {path} -> {e.code}: {detail}') from None


def sh(*args):
    subprocess.run(args, check=True)


def make_certificate(state):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = (x509.CertificateSigningRequestBuilder()
           .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'CI distribution')]))
           .sign(key, hashes.SHA256()))
    pem = csr.public_bytes(serialization.Encoding.PEM).decode()
    try:
        res = api('POST', '/certificates', {'data': {
            'type': 'certificates',
            'attributes': {'certificateType': 'DISTRIBUTION', 'csrContent': pem}}})
    except RuntimeError as e:
        if 'maximum' in str(e).lower() or 'limit' in str(e).lower():
            die('Certificate limit', 'Apple will not issue another distribution certificate: the team '
                'already holds its maximum. Revoke an unused one at developer.apple.com > Certificates '
                f'and run again. ({e})')
        raise
    data = res['data']
    state['certificate'] = data['id']
    STATE.write_text(json.dumps(state))
    cert = x509.load_der_x509_certificate(base64.b64decode(data['attributes']['certificateContent']))

    # The legacy PKCS#12 encoding: macOS `security import` rejects the
    # AES/PBKDF2 one newer libraries write by default.
    password = secrets.token_urlsafe(24)
    enc = (serialization.PrivateFormat.PKCS12.encryption_builder()
           .kdf_rounds(50000)
           .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
           .hmac_hash(hashes.SHA1())
           .build(password.encode()))
    p12 = TEMP / 'signing.p12'
    p12.write_bytes(pkcs12.serialize_key_and_certificates(b'ci', key, cert, None, enc))
    os.chmod(p12, 0o600)

    kc_pass = secrets.token_urlsafe(24)
    print(f'::add-mask::{password}')
    print(f'::add-mask::{kc_pass}')
    sh('security', 'create-keychain', '-p', kc_pass, str(KEYCHAIN))
    sh('security', 'set-keychain-settings', '-lut', '21600', str(KEYCHAIN))
    sh('security', 'unlock-keychain', '-p', kc_pass, str(KEYCHAIN))
    sh('security', 'import', str(p12), '-k', str(KEYCHAIN), '-P', password,
       '-T', '/usr/bin/codesign', '-T', '/usr/bin/security')
    sh('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s',
       '-k', kc_pass, str(KEYCHAIN))
    found = subprocess.run(['security', 'list-keychains', '-d', 'user'],
                           capture_output=True, text=True, check=True).stdout
    keychains = [k.strip().strip('"') for k in found.split()] if found.strip() else []
    sh('security', 'list-keychains', '-d', 'user', '-s', str(KEYCHAIN), *keychains)
    p12.unlink()


def bundle_id(identifier):
    res = api('GET', f'/bundleIds?filter[identifier]={identifier}&limit=200')
    for b in res.get('data', []):
        if b['attributes']['identifier'] == identifier:
            return b['id']
    die('Bundle ID missing', f'{identifier} is not registered. Add it at developer.apple.com > '
        'Certificates, Identifiers & Profiles > Identifiers (App IDs, Explicit).')


def ensure_associated_domains(bid):
    caps = api('GET', f'/bundleIds/{bid}/bundleIdCapabilities')
    if any(c['attributes'].get('capabilityType') == 'ASSOCIATED_DOMAINS' for c in caps.get('data', [])):
        return
    api('POST', '/bundleIdCapabilities', {'data': {
        'type': 'bundleIdCapabilities',
        'attributes': {'capabilityType': 'ASSOCIATED_DOMAINS'},
        'relationships': {'bundleId': {'data': {'type': 'bundleIds', 'id': bid}}}}})
    print('Turned on Associated Domains for the bundle ID.')


def make_profile(state, identifier, bid):
    name = f'CI {identifier} {os.environ.get("GITHUB_RUN_ID", int(time.time()))}'
    res = api('POST', '/profiles', {'data': {
        'type': 'profiles',
        'attributes': {'name': name, 'profileType': 'IOS_APP_STORE'},
        'relationships': {
            'bundleId': {'data': {'type': 'bundleIds', 'id': bid}},
            'certificates': {'data': [{'type': 'certificates', 'id': state['certificate']}]}}}})
    data = res['data']
    state['profile'] = data['id']
    STATE.write_text(json.dumps(state))
    content = base64.b64decode(data['attributes']['profileContent'])
    uuid = data['attributes']['uuid']
    home = pathlib.Path.home()
    for d in (home / 'Library/MobileDevice/Provisioning Profiles',
              home / 'Library/Developer/Xcode/UserData/Provisioning Profiles'):
        d.mkdir(parents=True, exist_ok=True)
        (d / f'{uuid}.mobileprovision').write_bytes(content)
    return name


def patch_project(pbxproj, identifier, profile):
    """Sign the App target's Release build manually with this profile.

    Done in the project, not on the xcodebuild command line: a setting passed
    there reaches the Swift package targets too, and a package target refuses
    a provisioning profile."""
    text = pbxproj.read_text()
    team = os.environ['APPLE_TEAM_ID']
    pattern = re.compile(r'(buildSettings = \{)([^{}]*?(?:\([^()]*\)[^{}]*?)*?'
                         r'PRODUCT_BUNDLE_IDENTIFIER = ' + re.escape(identifier) +
                         r';[^{}]*?(?:\([^()]*\)[^{}]*?)*?\};\s*name = Release;)')
    found = pattern.search(text)
    if not found:
        die('Project', f'No Release configuration for {identifier} in {pbxproj}.')
    body = re.sub(r'\n\s*(CODE_SIGN_STYLE|CODE_SIGN_IDENTITY|"CODE_SIGN_IDENTITY\[sdk=iphoneos\*\]"|'
                  r'DEVELOPMENT_TEAM|PROVISIONING_PROFILE_SPECIFIER|PROVISIONING_PROFILE) = [^;]*;',
                  '', found.group(2))
    settings = (f'\n\t\t\t\tCODE_SIGN_STYLE = Manual;'
                f'\n\t\t\t\tCODE_SIGN_IDENTITY = "Apple Distribution";'
                f'\n\t\t\t\t"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";'
                f'\n\t\t\t\tDEVELOPMENT_TEAM = {team};'
                f'\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "{profile}";')
    pbxproj.write_text(text[:found.start()] + found.group(1) + settings + body + text[found.end():])


def setup(identifier, pbxproj):
    state = {}
    STATE.write_text(json.dumps(state))
    make_certificate(state)
    bid = bundle_id(identifier)
    ensure_associated_domains(bid)
    profile = make_profile(state, identifier, bid)
    patch_project(pathlib.Path(pbxproj), identifier, profile)
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as f:
            f.write(f'profile={profile}\n')
    print(f'Signing ready: distribution certificate and App Store profile "{profile}" for {identifier}.')


def cleanup():
    if not STATE.exists():
        return
    state = json.loads(STATE.read_text())
    if state.get('profile'):
        try:
            api('DELETE', f"/profiles/{state['profile']}")
        except RuntimeError as e:
            print(f'::warning::Could not delete the CI profile: {e}')
    if state.get('certificate'):
        try:
            api('DELETE', f"/certificates/{state['certificate']}")
            print('Revoked the CI distribution certificate.')
        except RuntimeError as e:
            print(f'::warning title=Certificate left behind::Revoke it at developer.apple.com > '
                  f'Certificates, or the next run may hit Apple\'s limit. ({e})')
    if KEYCHAIN.exists():
        subprocess.run(['security', 'delete-keychain', str(KEYCHAIN)])
    STATE.unlink()


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    try:
        if cmd == 'setup' and len(sys.argv) == 4:
            setup(sys.argv[2], sys.argv[3])
        elif cmd == 'cleanup':
            cleanup()
        else:
            die('Usage', 'asc_signing.py setup <bundle id> <project.pbxproj> | cleanup')
    except RuntimeError as e:
        die('App Store Connect', str(e))
