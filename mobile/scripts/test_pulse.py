#!/usr/bin/env python3
"""Tests for the build's read-only guard (asc_read.py) and Lab Pulse (pulse.py).

    cd mobile && npm run check        (runs check.py, then this)

GitHub and App Store Connect are faked at the HTTP layer, so the real
classification, redirect and schema code runs. Stdlib only; the one test that
signs a real ES256 token runs when pyjwt and cryptography are installed (the
workflows' venv) and says it skipped otherwise.
"""
import contextlib
import copy
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
import urllib.error

TMP = tempfile.mkdtemp(prefix='pulse-test-')
os.environ['RUNNER_TEMP'] = TMP          # before asc_signing is imported: it reads this once
for k in ('GITHUB_STEP_SUMMARY', 'GITHUB_TOKEN', 'APPLE_TEAM_ID'):
    os.environ.pop(k, None)

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import asc_read  # noqa: E402
import asc_signing  # noqa: E402
import pulse  # noqa: E402

FIXTURE = HERE.parent.parent / 'challenge' / 'test' / 'fixtures' / 'pulse.json'
# Fakes, built here rather than written out, so no file in this public repo
# carries anything shaped like a token, a key id, a Team ID or an address.
def _b64(obj):
    import base64
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip('=')


FAKE_TOKEN = '.'.join([_b64({'alg': 'ES256'}), _b64({'iss': 'fake'}), _b64({'sig': 'fake'})])
FAKE_KID = 'K' * 10
FAKE_ISS = '0' * 8 + '-fake-issuer'
TEAM = 'Z' * 10
ADDRESS = 'holder' + '@' + 'example.com'
ASC_ID = '9' * 10          # the shape of an App Store Connect id; never kept
GH_TOKEN = 'ghs' + '_' + 'f' * 12
PLA = ('PLA Update available: You currently do not have access to this membership resource. To resolve '
       f'this issue, your team\'s Account Holder, Pat Example ({ADDRESS}), must agree to the latest '
       'Program License Agreement in their developer account.')
RUNS = 'https://github.com/eRock35/eriks-projects/actions/runs/'
NOW = pulse.parse_time('2026-11-08T12:00:00Z')


class FakeResponse(io.BytesIO):
    def __init__(self, body, status=200):
        super().__init__(body)
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class FakeASC:
    """urlopen stand-in: answers by path; records every request it saw."""

    def __init__(self, routes=None, default=None):
        self.routes = routes or {}
        self.default = default
        self.seen = []

    def __call__(self, req, timeout=None):
        self.seen.append((req.get_method(), req.full_url, dict(req.header_items())))
        path = req.full_url[len(asc_signing.API):]
        for prefix, answer in self.routes.items():
            if path.startswith(prefix):
                break
        else:
            answer = self.default
        if answer is None:
            raise urllib.error.URLError('unreachable')
        status, body = answer
        raw = json.dumps(body).encode() if not isinstance(body, bytes) else body
        if status >= 400:
            raise urllib.error.HTTPError(req.full_url, status, 'err', {}, io.BytesIO(raw))
        return FakeResponse(raw, status)


def apple_error(status, detail, code='FORBIDDEN_ERROR'):
    return status, {'errors': [{'status': str(status), 'code': code, 'title': 'Forbidden', 'detail': detail}]}


def builds_answer(number='5', state='IN_BETA_TESTING', expires='2027-01-01T06:14:00-08:00'):
    return 200, {
        'data': [{'type': 'builds', 'id': ASC_ID, 'attributes': {
            'version': number, 'processingState': 'VALID', 'uploadedDate': '2026-10-03T07:14:00-07:00',
            'expirationDate': expires, 'expired': False},
            'relationships': {'buildBetaDetail': {'data': {'type': 'buildBetaDetails', 'id': 'bbd-1'}},
                              'preReleaseVersion': {'data': {'type': 'preReleaseVersions', 'id': 'prv-1'}}}}],
        'included': [
            {'type': 'buildBetaDetails', 'id': 'bbd-1', 'attributes': {
                'externalBuildState': state, 'internalBuildState': 'IN_BETA_TESTING'}},
            {'type': 'preReleaseVersions', 'id': 'prv-1', 'attributes': {'version': '1.0'}}],
    }


def asc_ok_routes():
    routes = {}
    for slug, _, bundle in pulse.iphone_apps():
        routes[f'/apps?filter[bundleId]={bundle}'] = (200, {'data': [
            {'type': 'apps', 'id': ASC_ID[:7] + str(len(routes)).zfill(3), 'attributes': {'bundleId': bundle}}]})
    routes['/builds?filter[app]='] = builds_answer()
    routes['/apps?limit=1'] = (200, {'data': []})
    routes['/certificates?limit=1'] = (200, {'data': []})
    return routes


class FakeGitHub:
    """pulse.HTTP stand-in: the Actions API, plus the log redirect to storage."""

    def __init__(self, runs, jobs, logs=None, ci_runs=None, ci_jobs=None, fail=False):
        self.runs, self.jobs, self.logs = runs, jobs, logs or {}
        self.ci_runs = ci_runs if ci_runs is not None else [ci_run()]
        self.ci_jobs = ci_jobs if ci_jobs is not None else [{'name': 'test', 'status': 'completed', 'conclusion': 'success', 'steps': []}]
        self.fail = fail
        self.seen = []

    def __call__(self, url, headers, follow=True, limit=None):
        self.seen.append((url, dict(headers), follow))
        if self.fail:
            return 503, {}, b''
        api = pulse.GITHUB_API + '/repos/' + pulse.REPO
        if url.startswith('https://storage.example/log/'):
            return 200, {}, self.logs[int(url.rsplit('/', 1)[1])].encode()
        if url.startswith(api + '/actions/jobs/') and url.endswith('/logs'):
            jid = int(url.split('/')[-2])
            if jid not in self.logs:
                return 404, {}, b''
            return 302, {'Location': f'https://storage.example/log/{jid}'}, b''
        if url.startswith(api + '/actions/workflows/ios.yml/runs'):
            return 200, {}, json.dumps({'workflow_runs': self.runs}).encode()
        if url.startswith(api + '/actions/workflows/ci.yml/runs'):
            return 200, {}, json.dumps({'workflow_runs': self.ci_runs}).encode()
        if '/actions/runs/' in url and '/jobs' in url:
            rid = int(url.split('/actions/runs/')[1].split('/')[0])
            if rid == 777:
                return 200, {}, json.dumps({'jobs': self.ci_jobs}).encode()
            return 200, {}, json.dumps({'jobs': self.jobs.get(rid, [])}).encode()
        return 404, {}, b''


def run(rid, number, title='iPhone apps to TestFlight', event='schedule', conclusion='failure', at='2026-11-01T09:23:41Z'):
    return {'id': rid, 'run_number': number, 'display_title': title, 'event': event, 'status': 'completed',
            'conclusion': conclusion, 'created_at': at, 'run_started_at': at, 'html_url': f'{RUNS}{rid}'}


def ci_run():
    return {'id': 777, 'run_number': 112, 'status': 'completed', 'conclusion': 'success', 'event': 'push',
            'created_at': '2026-11-07T21:10:00Z', 'updated_at': '2026-11-07T21:14:09Z', 'html_url': f'{RUNS}777'}


def app_job(rid, jid, slug, ok, failed_step='Signing'):
    steps = [{'name': 'Set up job', 'conclusion': 'success'}]
    if ok:
        steps += [{'name': n, 'conclusion': 'success'} for n in ('Signing', 'Archive', 'Upload to TestFlight')]
    else:
        steps += [{'name': failed_step, 'conclusion': 'failure'}, {'name': 'Archive', 'conclusion': 'skipped'}]
    return {'id': jid, 'name': slug, 'status': 'completed', 'conclusion': 'success' if ok else 'failure',
            'started_at': '2026-11-01T09:30:00Z', 'completed_at': '2026-11-01T09:31:00Z',
            'html_url': f'{RUNS}{rid}/job/{jid}', 'steps': steps}


def plan_job(rid, jid, ok=True, failed='App Store Connect answers (read-only)'):
    steps = [{'name': 'Check the four secrets are set', 'conclusion': 'success'}]
    steps.append({'name': failed, 'conclusion': 'success' if ok else 'failure'})
    return {'id': jid, 'name': pulse.PLAN_JOB, 'status': 'completed', 'conclusion': 'success' if ok else 'failure',
            'started_at': '2026-12-01T09:23:50Z', 'completed_at': '2026-12-01T09:24:30Z',
            'html_url': f'{RUNS}{rid}/job/{jid}', 'steps': steps}


SLUGS = [s for s, _, _ in pulse.iphone_apps()]


def november_first():
    """Run #7 (2026-11-01): every app failed at Signing on the agreement.
    Run #6: a check-only run. Run #5 (2026-10-03): every app uploaded."""
    jobs, logs = {}, {}
    jobs[107] = [plan_job(107, 1000)] + [app_job(107, 1100 + i, s, False) for i, s in enumerate(SLUGS)]
    for i in range(len(SLUGS)):
        logs[1100 + i] = ('2026-11-01T09:31:00Z ##[group]Run python scripts/asc_signing.py setup\n'
                          f'::error title=App Store Connect::POST /certificates -> 403: Forbidden: {PLA}\n')
    jobs[106] = [plan_job(106, 990)]
    jobs[105] = [plan_job(105, 900)] + [app_job(105, 950 + i, s, True) for i, s in enumerate(SLUGS)]
    runs = [run(107, 7), run(106, 6, title='iPhone apps: check only, no build', event='workflow_dispatch', conclusion='success'),
            run(105, 5, event='workflow_dispatch', conclusion='success', at='2026-10-03T14:00:00Z')]
    return runs, jobs, logs


@contextlib.contextmanager
def env(**values):
    old = {k: os.environ.get(k) for k in values}
    for k, v in values.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class Base(unittest.TestCase):
    def setUp(self):
        self.real_open, self.real_token, self.real_http = asc_read.OPEN, asc_signing.token, pulse.HTTP
        asc_signing.token = lambda: FAKE_TOKEN
        self.key = pathlib.Path(TMP) / 'AuthKey.p8'
        self.key.write_text('-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n')
        self.env = env(APPSTORE_KEY_ID=FAKE_KID, APPSTORE_ISSUER_ID=FAKE_ISS, APPLE_TEAM_ID=TEAM)
        self.env.__enter__()

    def tearDown(self):
        asc_read.OPEN, asc_signing.token, pulse.HTTP = self.real_open, self.real_token, self.real_http
        self.env.__exit__(None, None, None)
        self.key.unlink(missing_ok=True)

    def assertNoSecrets(self, text):
        for s in (FAKE_TOKEN, FAKE_KID, FAKE_ISS, TEAM, 'BEGIN PRIVATE KEY', 'not-a-real-key',
                  ADDRESS, ASC_ID[:7]):
            self.assertNotIn(s, text)
        self.assertIsNone(asc_read.EMAIL.search(text), text)


class Preflight(Base):
    def go(self, fake):
        asc_read.OPEN = fake
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = asc_read.preflight()
        return code, out.getvalue()

    def test_passes_and_says_it_cannot_prove_the_agreement(self):
        fake = FakeASC(asc_ok_routes())
        code, out = self.go(fake)
        self.assertEqual(code, 0)
        self.assertIn('Read-only checks passed', out)
        self.assertIn('An unaccepted agreement may still stop signing', out)
        self.assertEqual([m for m, _, _ in fake.seen], ['GET', 'GET'])
        self.assertEqual([u.split('/v1')[1] for _, u, _ in fake.seen], ['/apps?limit=1', '/certificates?limit=1'])
        self.assertNoSecrets(out)

    def test_every_request_is_a_get_with_the_shared_token(self):
        fake = FakeASC(asc_ok_routes())
        self.go(fake)
        for method, _, headers in fake.seen:
            self.assertEqual(method, 'GET')
            self.assertEqual(headers.get('Authorization'), 'Bearer ' + FAKE_TOKEN)

    def test_agreement_403_stops_with_the_plain_sentence(self):
        code, out = self.go(FakeASC(default=apple_error(403, PLA)))
        self.assertEqual(code, 1)
        self.assertIn('::error title=Apple agreement::The Account Holder must accept the updated Apple '
                      'Developer Program License Agreement at developer.apple.com, then re-run.', out)
        self.assertNoSecrets(out)
        self.assertNotIn('Pat Example', out)   # Apple's own text is not echoed for the agreement

    def test_asc_required_agreements_code_counts_too(self):
        code, out = self.go(FakeASC(default=apple_error(403, 'A required agreement is missing or has expired.',
                                                        'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED')))
        self.assertEqual(code, 1)
        self.assertIn('title=Apple agreement', out)

    def test_401_is_a_bad_key(self):
        code, out = self.go(FakeASC(default=apple_error(401, 'Authentication credentials are missing or invalid.', 'NOT_AUTHORIZED')))
        self.assertEqual(code, 1)
        self.assertIn('title=App Store Connect key refused', out)
        self.assertNoSecrets(out)

    def test_another_403_stops_too(self):
        code, out = self.go(FakeASC({'/apps': (200, {'data': []})},
                                    default=apple_error(403, 'The API key in use does not allow this request')))
        self.assertEqual(code, 1)
        self.assertIn('title=App Store Connect access refused', out)
        self.assertIn('GET certificates', out)

    def test_apple_down_warns_and_lets_the_build_run(self):
        for fake in (FakeASC(default=(503, b'<html>down</html>')), FakeASC(default=None)):
            code, out = self.go(fake)
            self.assertEqual(code, 0)
            self.assertIn('::warning', out)

    def test_a_token_that_will_not_sign_stops(self):
        def broken():
            raise ValueError('Could not deserialize key data')
        asc_signing.token = broken
        code, out = self.go(FakeASC(asc_ok_routes()))
        self.assertEqual(code, 1)
        self.assertIn('title=APPSTORE_KEY_P8', out)

    def test_scrub(self):
        s = asc_read.scrub(f'call {ADDRESS} about {FAKE_TOKEN}\n\x07now ' + 'x' * 500)
        self.assertNotIn('@', s)
        self.assertNotIn('eyJ', s)
        self.assertNotIn('\x07', s)
        self.assertLessEqual(len(s), 300)

    def test_classify(self):
        self.assertEqual(asc_read.classify(403, PLA), 'agreement')
        self.assertEqual(asc_read.classify(401, 'whatever'), 'auth')
        self.assertEqual(asc_read.classify(403, 'nope'), 'forbidden')
        self.assertEqual(asc_read.classify(500, 'agreement'), 'error')
        self.assertEqual(asc_read.classify(0, ''), 'error')


class RealToken(Base):
    """asc_signing.token() itself, unmodified, through the guard."""

    def test_signs_es256_with_the_key_id_and_prints_none_of_it(self):
        try:
            import jwt
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import ec
        except KeyboardInterrupt:
            raise
        except BaseException:  # noqa: BLE001 - missing, or a broken system build (a pyo3 panic)
            self.skipTest('pyjwt/cryptography not usable here; run with the workflows\' venv')
        asc_signing.token = self.real_token
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption()).decode()
        self.key.write_text(pem)
        fake = FakeASC(asc_ok_routes())
        asc_read.OPEN = fake
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(asc_read.preflight(), 0)
        tok = fake.seen[0][2]['Authorization'].split(' ', 1)[1]
        head = jwt.get_unverified_header(tok)
        self.assertEqual((head['alg'], head['kid']), ('ES256', FAKE_KID))
        claims = jwt.decode(tok, key.public_key(), algorithms=['ES256'], audience='appstoreconnect-v1')
        self.assertEqual(claims['iss'], FAKE_ISS)
        printed = out.getvalue()
        for s in (tok, FAKE_KID, FAKE_ISS, pem.splitlines()[1]):
            self.assertNotIn(s, printed)


class Gather(Base):
    def gather(self, gh, asc):
        pulse.HTTP = gh
        asc_read.OPEN = asc
        doc = pulse.build_doc(NOW)
        text = pulse.serialise(doc)
        self.assertEqual(pulse.validate(doc), [])
        self.assertEqual(pulse.leaks(text), [])
        self.assertNoSecrets(text)
        return doc, text

    def apps(self, doc):
        return {a['slug']: a for a in doc['iphone']['apps']}

    def test_november_first(self):
        runs, jobs, logs = november_first()
        gh = FakeGitHub(runs, jobs, logs)
        doc, text = self.gather(gh, FakeASC(asc_ok_routes()))
        apps = self.apps(doc)
        self.assertEqual(list(apps), SLUGS)
        for slug, a in apps.items():
            self.assertEqual(a['latest']['run'], 7)
            self.assertEqual(a['latest']['conclusion'], 'failure')
            self.assertEqual(a['latest']['failedStep'], 'Signing')
            self.assertEqual(a['latest']['failure'], 'agreement')
            self.assertEqual(a['lastUpload']['run'], 5)
            self.assertTrue(a['latest']['url'].startswith(RUNS + '107/job/'))
            b = a['asc']['build']
            self.assertEqual((b['version'], b['number'], b['processingState']), ('1.0', '5', 'VALID'))
            self.assertEqual(b['uploadedAt'], '2026-10-03T14:14:00Z')
            self.assertEqual(b['expiresAt'], '2027-01-01T14:14:00Z')
            self.assertEqual(b['daysToExpiry'], 54)
            self.assertEqual(b['external'], 'IN_BETA_TESTING')
            self.assertFalse(a['expiresBeforeNextBuild'])
        self.assertEqual(doc['iphone']['nextScheduled'], '2026-12-01T09:23:00Z')
        self.assertEqual(doc['iphone']['lastRun']['number'], 7)
        self.assertFalse(doc['iphone']['lastRun']['checkOnly'])
        self.assertEqual(doc['ci']['conclusion'], 'success')
        self.assertEqual(doc['ci']['jobs'], [{'name': 'test', 'conclusion': 'success', 'failedStep': None}])
        self.assertTrue(doc['asc']['ok'] and doc['github']['ok'])
        self.assertNotIn(ASC_ID, text)   # Apple's build and app ids
        self.assertNotIn('bbd-1', text)

    def test_logs_are_fetched_without_our_token(self):
        runs, jobs, logs = november_first()
        gh = FakeGitHub(runs, jobs, logs)
        with env(GITHUB_TOKEN=GH_TOKEN):
            self.gather(gh, FakeASC(asc_ok_routes()))
        storage = [h for u, h, _ in gh.seen if u.startswith('https://storage.example/')]
        self.assertEqual(len(storage), len(SLUGS))
        self.assertTrue(all('Authorization' not in h for h in storage))
        api = [h for u, h, _ in gh.seen if u.startswith(pulse.GITHUB_API)]
        self.assertTrue(all(h.get('Authorization') == 'Bearer ' + GH_TOKEN for h in api))
        self.assertTrue(all(not f for u, _, f in gh.seen if u.endswith('/logs')))

    def test_asc_agreement_403_is_recorded_and_the_file_still_written(self):
        runs, jobs, logs = november_first()
        doc, _ = self.gather(FakeGitHub(runs, jobs, logs), FakeASC(default=apple_error(403, PLA)))
        self.assertEqual(doc['asc'], {'ok': False, 'reason': 'agreement'})
        for a in doc['iphone']['apps']:
            self.assertEqual(a['asc'], {'ok': False, 'reason': 'agreement'})
            self.assertEqual(a['latest']['failure'], 'agreement')

    def test_asc_401_and_unset(self):
        runs, jobs, logs = november_first()
        doc, _ = self.gather(FakeGitHub(runs, jobs, logs), FakeASC(default=apple_error(401, 'bad', 'NOT_AUTHORIZED')))
        self.assertEqual(doc['asc'], {'ok': False, 'reason': 'auth'})
        self.key.unlink()
        doc, _ = self.gather(FakeGitHub(runs, jobs, logs), FakeASC(asc_ok_routes()))
        self.assertEqual(doc['asc'], {'ok': False, 'reason': 'unset'})
        self.assertTrue(all(a['asc'] == {'ok': False, 'reason': 'unset'} for a in doc['iphone']['apps']))

    def test_app_missing_from_asc_and_no_builds(self):
        runs, jobs, logs = november_first()
        routes = asc_ok_routes()
        routes['/apps?filter[bundleId]=com.strongtechnicalconsulting.football'] = (200, {'data': []})
        routes['/builds?filter[app]='] = (200, {'data': []})
        doc, _ = self.gather(FakeGitHub(runs, jobs, logs), FakeASC(routes))
        apps = self.apps(doc)
        self.assertEqual(apps['football']['asc'], {'ok': True, 'found': False, 'build': None})
        self.assertEqual(apps['trip']['asc'], {'ok': True, 'found': True, 'build': None})

    def test_expiry_before_the_next_scheduled_build(self):
        runs, jobs, logs = november_first()
        routes = asc_ok_routes()
        routes['/builds?filter[app]='] = builds_answer(expires='2026-11-20T10:00:00Z')
        doc, _ = self.gather(FakeGitHub(runs, jobs, logs), FakeASC(routes))
        self.assertTrue(all(a['expiresBeforeNextBuild'] for a in doc['iphone']['apps']))
        self.assertEqual(doc['iphone']['apps'][0]['asc']['build']['daysToExpiry'], 11)

    def test_unknown_apple_states_and_odd_numbers_are_neutralised(self):
        runs, jobs, logs = november_first()
        routes = asc_ok_routes()
        routes['/builds?filter[app]='] = builds_answer(number=ASC_ID, state='SOMETHING_NEW')
        doc, _ = self.gather(FakeGitHub(runs, jobs, logs), FakeASC(routes))
        b = doc['iphone']['apps'][0]['asc']['build']
        self.assertIsNone(b['number'])           # ten digits is an id, never a build number
        self.assertEqual(b['external'], 'UNKNOWN')

    def test_the_guard_stopping_a_run_shows_on_every_targeted_app(self):
        runs, jobs, logs = november_first()
        runs.insert(0, run(108, 8, title='iPhone apps to TestFlight: all', at='2026-12-01T09:23:41Z'))
        jobs[108] = [plan_job(108, 2000, ok=False)]
        logs[2000] = ('::error title=Apple agreement::The Account Holder must accept the updated Apple Developer '
                      'Program License Agreement at developer.apple.com, then re-run.\n')
        doc, _ = self.gather(FakeGitHub(runs, jobs, logs), FakeASC(asc_ok_routes()))
        for a in doc['iphone']['apps']:
            self.assertEqual(a['latest']['run'], 8)
            self.assertTrue(a['latest']['stoppedInPlan'])
            self.assertEqual(a['latest']['failedStep'], 'App Store Connect answers (read-only)')
            self.assertEqual(a['latest']['failure'], 'agreement')
            self.assertEqual(a['lastUpload']['run'], 5)

    def test_a_one_app_run_stopped_in_plan_names_only_that_app(self):
        runs, jobs, logs = november_first()
        runs.insert(0, run(108, 8, title='iPhone apps to TestFlight: trip', event='workflow_dispatch'))
        jobs[108] = [plan_job(108, 2000, ok=False, failed='Check the four secrets are set')]
        logs[2000] = '::error title=Missing secrets::Add these repository secrets: APPLE_TEAM_ID\n'
        doc, _ = self.gather(FakeGitHub(runs, jobs, logs), FakeASC(asc_ok_routes()))
        apps = self.apps(doc)
        self.assertEqual(apps['trip']['latest']['run'], 8)
        self.assertEqual(apps['trip']['latest']['failure'], 'secrets')
        self.assertEqual(apps['hopscotch']['latest']['run'], 7)

    def test_check_only_runs_are_no_apps_result_but_are_the_last_run(self):
        runs, jobs, logs = november_first()
        runs.insert(0, run(109, 9, title='iPhone apps: check only, no build', event='workflow_dispatch', conclusion='success'))
        jobs[109] = [plan_job(109, 3000)]
        doc, _ = self.gather(FakeGitHub(runs, jobs, logs), FakeASC(asc_ok_routes()))
        self.assertEqual(doc['iphone']['lastRun']['number'], 9)
        self.assertTrue(doc['iphone']['lastRun']['checkOnly'])
        self.assertTrue(all(a['latest']['run'] == 7 for a in doc['iphone']['apps']))

    def test_upload_counts_only_when_the_upload_step_succeeded(self):
        runs, jobs, logs = november_first()
        j = app_job(105, 950, 'trip', True)
        j['conclusion'] = 'failure'                   # revoke failed after the upload
        j['steps'].append({'name': 'Revoke the CI certificate', 'conclusion': 'failure'})
        jobs[105][1] = j
        logs[950] = "::warning title=Certificate left behind::Revoke it\n"
        doc, _ = self.gather(FakeGitHub(runs, jobs, logs), FakeASC(asc_ok_routes()))
        self.assertEqual(self.apps(doc)['trip']['lastUpload']['run'], 5)

    def test_github_down_still_writes_a_valid_file(self):
        doc, _ = self.gather(FakeGitHub([], {}, fail=True), FakeASC(asc_ok_routes()))
        self.assertFalse(doc['github']['ok'])
        self.assertIsNone(doc['iphone']['lastRun'])
        self.assertIsNone(doc['ci'])
        self.assertTrue(all(a['latest'] is None for a in doc['iphone']['apps']))

    def test_main_writes_and_checks(self):
        runs, jobs, logs = november_first()
        pulse.HTTP, asc_read.OPEN = FakeGitHub(runs, jobs, logs), FakeASC(asc_ok_routes())
        out = pathlib.Path(TMP) / 'pulse.json'
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(pulse.main(['--out', str(out)]), 0)
            self.assertEqual(pulse.main(['--check', str(out)]), 0)
        self.assertNoSecrets(out.read_text() + printed.getvalue())
        bad = json.loads(out.read_text())
        bad['iphone']['apps'][0]['latest']['failedStep'] = 'Signing for ' + ADDRESS
        out.write_text(json.dumps(bad))
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(pulse.main(['--check', str(out)]), 1)
        self.assertIn('nothing written', printed.getvalue())


class Schema(unittest.TestCase):
    def setUp(self):
        self.doc = json.loads(FIXTURE.read_text())

    def test_the_shared_fixture_is_valid(self):
        # challenge/test/pulse.js validates the same file with the host's own
        # validator, so the two schemas are held to one document.
        self.assertEqual(pulse.validate(self.doc), [])
        self.assertEqual(pulse.leaks(FIXTURE.read_text()), [])

    def bad(self, mutate):
        d = copy.deepcopy(self.doc)
        mutate(d)
        self.assertNotEqual(pulse.validate(d), [], 'accepted a bad document')

    def test_refuses(self):
        a = lambda d: d['iphone']['apps'][0]  # noqa: E731
        self.bad(lambda d: d.update(schema=2))
        self.bad(lambda d: d.update(extra='x'))
        self.bad(lambda d: d.update(generatedAt='yesterday'))
        self.bad(lambda d: a(d).update(teamId=TEAM))
        self.bad(lambda d: a(d).update(slug='Trip'))
        self.bad(lambda d: a(d).update(bundleId='com.example.trip'))
        self.bad(lambda d: a(d)['latest'].update(url='https://evil.example/eRock35/eriks-projects/actions/runs/1'))
        self.bad(lambda d: a(d)['latest'].update(url='http://github.com/eRock35/eriks-projects/actions/runs/1'))
        self.bad(lambda d: a(d)['latest'].update(url='https://appstoreconnect.apple.com/apps/' + ASC_ID + '/testflight'))
        self.bad(lambda d: a(d)['latest'].update(failedStep='<img src=x onerror=alert(1)>'))
        self.bad(lambda d: a(d)['latest'].update(failedStep='mail ' + ADDRESS))
        self.bad(lambda d: a(d)['latest'].update(failure='PLA Update available'))
        self.bad(lambda d: a(d)['latest'].update(run=True))
        self.bad(lambda d: a(d)['asc']['build'].update(number=ASC_ID))
        self.bad(lambda d: a(d)['asc']['build'].update(appId=ASC_ID))
        self.bad(lambda d: a(d)['asc']['build'].update(external='HACKED'))
        self.bad(lambda d: a(d)['asc']['build'].update(expiresAt='2027-01-01'))
        self.bad(lambda d: a(d).update(asc={'ok': False, 'reason': 'the key is ' + FAKE_KID}))
        self.bad(lambda d: d.update(asc={'ok': True, 'token': FAKE_TOKEN}))
        self.bad(lambda d: d['ci'].update(workflow='other.yml'))
        self.bad(lambda d: d['ci']['jobs'].append({'name': 'x' * 200, 'conclusion': 'success', 'failedStep': None}))
        self.bad(lambda d: d['iphone']['apps'].append(copy.deepcopy(d['iphone']['apps'][0])))

    def test_leaks(self):
        text = FIXTURE.read_text()
        self.assertEqual(pulse.leaks(text), [])
        self.assertIn('an email address', pulse.leaks(text + ADDRESS))
        self.assertIn('a token', pulse.leaks(text + FAKE_TOKEN))
        self.assertIn('a Team ID', pulse.leaks(text + TEAM + '.com.strongtechnicalconsulting.trip'))
        with env(APPSTORE_KEY_ID=FAKE_KID):
            self.assertIn('APPSTORE_KEY_ID', pulse.leaks(text + FAKE_KID))

    def test_log_words(self):
        self.assertEqual(pulse.classify_log(PLA), 'agreement')
        self.assertEqual(pulse.classify_log('::error title=Certificate limit::max'), 'certificate-limit')
        self.assertEqual(pulse.classify_log('::error title=Missing secrets::Add'), 'secrets')
        self.assertEqual(pulse.classify_log('POST /profiles -> 401: NOT_AUTHORIZED'), 'auth')
        self.assertEqual(pulse.classify_log('xcodebuild: error: compile failed'), 'other')

    def test_apps_come_from_generate_mjs(self):
        self.assertEqual([s for s, _, _ in pulse.iphone_apps()], ['trip', 'hopscotch', 'flight', 'football', 'insidejoke'])
        self.assertTrue(all(b == 'com.strongtechnicalconsulting.' + s for s, _, b in pulse.iphone_apps()))

    def test_next_scheduled(self):
        t = pulse.parse_time
        self.assertEqual(pulse.iso(pulse.next_scheduled(t('2026-11-08T12:00:00Z'))), '2026-12-01T09:23:00Z')
        self.assertEqual(pulse.iso(pulse.next_scheduled(t('2026-11-01T09:22:59Z'))), '2026-11-01T09:23:00Z')
        self.assertEqual(pulse.iso(pulse.next_scheduled(t('2026-12-15T00:00:00Z'))), '2027-01-01T09:23:00Z')


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=1).result
    skipped = len(result.skipped)
    print(f'\npulse tests: {result.testsRun - len(result.failures) - len(result.errors) - skipped} passed, '
          f'{len(result.failures) + len(result.errors)} failed, {skipped} skipped')
    sys.exit(0 if result.wasSuccessful() else 1)
