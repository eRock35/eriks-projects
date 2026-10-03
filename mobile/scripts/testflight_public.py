#!/usr/bin/env python3
"""Open each iPhone app to the public through a TestFlight public link.

For every app in mobile/testflight.json (or the one named on the command
line), through the App Store Connect API:

  1. Test information: the beta description and privacy policy from that
     file; the reviewer notes, with "no demo account needed". The feedback
     email and the reviewer's name, phone and email are Erik's, so they are
     typed into App Store Connect by hand and never written in this public
     repo. Until they are there, the build is not sent for review.
  2. A "Public" external group, with its public link switched on once Apple
     allows it (it may wait for the first approved build).
  3. The newest build (waiting while Apple processes it), with "What to Test",
     added to that group and sent to Beta App Review when it needs it.
  4. The public link, printed and written to the job summary. The websites
     show it from a Cloud Run setting (TESTFLIGHT_URL...), which stays unset
     until a build is approved, so no button points at a link that cannot
     take testers yet.

Safe to run again: everything is looked up first and only made or changed
when it is missing or different.
"""
import json
import os
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from asc_signing import api  # noqa: E402  (same key, same token, same errors)

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / 'testflight.json').read_text())
GROUP = 'Public'
LOCALE = 'en-US'
WAIT_SECONDS = int(os.environ.get('TESTFLIGHT_WAIT_SECONDS', '2400'))
REVIEW_FIELDS = ('contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail')
APPROVED = {'BETA_APPROVED', 'IN_BETA_TESTING', 'READY_FOR_BETA_TESTING'}
SENT = {'WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW'}

summary = []


def say(line=''):
    print(line, flush=True)
    summary.append(line)


def notice(title, msg):
    print(f'::notice title={title}::{msg}', flush=True)


def warn(title, msg):
    print(f'::warning title={title}::{msg}', flush=True)
    summary.append(f'> **{title}:** {msg}')


def find_app(bundle):
    res = api('GET', f'/apps?filter[bundleId]={bundle}&limit=50')
    for a in res.get('data', []):
        if a['attributes']['bundleId'] == bundle:
            return a
    return None


def test_information(app_id, cfg):
    """Description and privacy policy; returns the feedback email if one is set."""
    locs = api('GET', f'/apps/{app_id}/betaAppLocalizations').get('data', [])
    loc = next((l for l in locs if l['attributes'].get('locale') == LOCALE), None)
    want = {'description': cfg['description'], 'privacyPolicyUrl': CONFIG['privacyPolicyUrl']}
    if loc is None:
        loc = api('POST', '/betaAppLocalizations', {'data': {
            'type': 'betaAppLocalizations',
            'attributes': {'locale': LOCALE, **want},
            'relationships': {'app': {'data': {'type': 'apps', 'id': app_id}}}}})['data']
    else:
        change = {k: v for k, v in want.items() if loc['attributes'].get(k) != v}
        if change:
            loc = api('PATCH', f"/betaAppLocalizations/{loc['id']}", {'data': {
                'type': 'betaAppLocalizations', 'id': loc['id'], 'attributes': change}})['data']
    return loc['attributes'].get('feedbackEmail')


def review_details(app_id, cfg):
    """Reviewer notes and no demo account; returns the contact fields still empty."""
    d = api('GET', f'/apps/{app_id}/betaAppReviewDetail')['data']
    missing = [f for f in REVIEW_FIELDS if not d['attributes'].get(f)]
    if missing:
        # Apple refuses any change to this record until the contact is on it,
        # so the notes wait for the run after Erik fills that in.
        return missing
    want = {'notes': cfg['reviewNotes'], 'demoAccountRequired': False}
    change = {k: v for k, v in want.items() if d['attributes'].get(k) != v}
    if change:
        # Apple wants the contact sent back with every change.
        attrs = {f: d['attributes'][f] for f in REVIEW_FIELDS}
        attrs.update(change)
        api('PATCH', f"/betaAppReviewDetails/{d['id']}", {'data': {
            'type': 'betaAppReviewDetails', 'id': d['id'], 'attributes': attrs}})
    return []


def public_group(app_id):
    groups = api('GET', f'/apps/{app_id}/betaGroups?limit=200').get('data', [])
    g = next((x for x in groups if x['attributes'].get('name') == GROUP
              and not x['attributes'].get('isInternalGroup')), None)
    if g is None:
        g = api('POST', '/betaGroups', {'data': {
            'type': 'betaGroups',
            'attributes': {'name': GROUP, 'feedbackEnabled': True},
            'relationships': {'app': {'data': {'type': 'apps', 'id': app_id}}}}})['data']
        say(f'- Made the "{GROUP}" tester group.')
    return g


def enable_link(g):
    a = g['attributes']
    if a.get('publicLinkEnabled') and a.get('publicLink'):
        return a['publicLink']
    try:
        g = api('PATCH', f"/betaGroups/{g['id']}", {'data': {
            'type': 'betaGroups', 'id': g['id'],
            'attributes': {'publicLinkEnabled': True, 'publicLinkLimitEnabled': False}}})['data']
    except RuntimeError as e:
        notice('Public link', f'Apple would not switch the link on yet ({e}). It usually allows it once a build is approved; the next run tries again.')
        return None
    return g['attributes'].get('publicLink')


def newest_build(app_id):
    """The newest build, waiting while Apple is still processing it."""
    deadline = time.time() + WAIT_SECONDS
    while True:
        res = api('GET', f'/builds?filter[app]={app_id}&sort=-uploadedDate&limit=1'
                         '&include=buildBetaDetail,preReleaseVersion')
        builds = res.get('data', [])
        if not builds:
            return None, None, None
        b = builds[0]
        inc = {(x['type'], x['id']): x for x in res.get('included', [])}
        detail = inc.get(('buildBetaDetails', (b['relationships']['buildBetaDetail']['data'] or {}).get('id')))
        ver = inc.get(('preReleaseVersions', (b['relationships']['preReleaseVersion']['data'] or {}).get('id')))
        state = b['attributes'].get('processingState')
        if state == 'PROCESSING' and time.time() < deadline:
            print(f"  build {b['attributes']['version']} is still processing at Apple; waiting...", flush=True)
            time.sleep(30)
            continue
        version = ver['attributes']['version'] if ver else '?'
        ext = detail['attributes'].get('externalBuildState') if detail else None
        return b, version, ext


def what_to_test(build_id, text):
    locs = api('GET', f'/builds/{build_id}/betaBuildLocalizations').get('data', [])
    loc = next((l for l in locs if l['attributes'].get('locale') == LOCALE), None)
    if loc is None:
        api('POST', '/betaBuildLocalizations', {'data': {
            'type': 'betaBuildLocalizations',
            'attributes': {'locale': LOCALE, 'whatsNew': text},
            'relationships': {'build': {'data': {'type': 'builds', 'id': build_id}}}}})
    elif not loc['attributes'].get('whatsNew'):
        api('PATCH', f"/betaBuildLocalizations/{loc['id']}", {'data': {
            'type': 'betaBuildLocalizations', 'id': loc['id'], 'attributes': {'whatsNew': text}}})


def add_to_group(group_id, build_id):
    have = api('GET', f'/betaGroups/{group_id}/relationships/builds?limit=200').get('data', [])
    if any(x['id'] == build_id for x in have):
        return
    api('POST', f'/betaGroups/{group_id}/relationships/builds',
        {'data': [{'type': 'builds', 'id': build_id}]})


def submit(build_id):
    api('POST', '/betaAppReviewSubmissions', {'data': {
        'type': 'betaAppReviewSubmissions',
        'relationships': {'build': {'data': {'type': 'builds', 'id': build_id}}}}})


def one(slug, cfg):
    bundle = cfg['bundleId']
    say(f'### {slug} ({bundle})')
    app = find_app(bundle)
    if not app:
        warn(slug, f'No app in App Store Connect with bundle ID {bundle}. Make it under Apps > + > New App.')
        return None
    app_id = app['id']

    feedback = test_information(app_id, cfg)
    missing = review_details(app_id, cfg)
    todo = []
    if not feedback:
        todo.append('feedback email')
    if missing:
        todo.append('reviewer contact (' + ', '.join(missing) + ')')
    if todo:
        warn(f'{slug}: Test Information',
             'Fill in ' + ' and '.join(todo) + ' at App Store Connect > the app > TestFlight > '
             'Test Information. The build is not sent for review until then.')

    g = public_group(app_id)
    b, version, ext = newest_build(app_id)
    if not b:
        warn(slug, 'No build uploaded yet. Run the "iPhone apps to TestFlight" workflow first.')
    else:
        build_id, number = b['id'], b['attributes']['version']
        say(f'- Newest build: {version} ({number}), processing {b["attributes"].get("processingState")}, '
            f'external state {ext}.')
        if b['attributes'].get('processingState') != 'VALID':
            warn(slug, f'Build {number} is not ready ({b["attributes"].get("processingState")}). Run this again later.')
        else:
            what_to_test(build_id, cfg['whatsNew'])
            add_to_group(g['id'], build_id)
            if ext in APPROVED:
                say('- Approved for external testing.')
            elif ext in SENT:
                say('- With Apple for Beta App Review.')
            elif ext == 'BETA_REJECTED':
                warn(slug, f'Apple rejected build {number} in Beta App Review. Their reasons are in '
                     'App Store Connect > TestFlight; reply there or fix and build again.')
            elif ext == 'READY_FOR_BETA_SUBMISSION' and not todo:
                try:
                    submit(build_id)
                    say('- Sent to Beta App Review (usually under a day).')
                except RuntimeError as e:
                    warn(slug, f'Could not send build {number} for review: {e}')
            elif ext == 'READY_FOR_BETA_SUBMISSION':
                say('- Ready to send for review once Test Information is filled in.')
            else:
                say(f'- Nothing to do while the build is {ext}.')

    link = enable_link(api('GET', f"/betaGroups/{g['id']}")['data'])
    if link:
        say(f'- Public link: {link}')
    return link


def main():
    only = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != 'all' else None
    apps = CONFIG['apps']
    if only and only not in apps:
        print(f'::error::Unknown app {only}; one of {", ".join(apps)} or all.')
        sys.exit(1)
    links = {}
    for slug, cfg in apps.items():
        if only and slug != only:
            continue
        try:
            links[slug] = one(slug, cfg)
        except RuntimeError as e:
            warn(slug, str(e))
        say()
    say('### Public links')
    for slug, link in links.items():
        say(f'- {slug}: {link or "not on yet"}')
    out = os.environ.get('GITHUB_STEP_SUMMARY')
    if out:
        with open(out, 'a') as f:
            f.write('\n'.join(summary) + '\n')


if __name__ == '__main__':
    main()
