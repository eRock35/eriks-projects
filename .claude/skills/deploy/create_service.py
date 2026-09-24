#!/usr/bin/env python3
"""First deploy of a standard app: build, create the Cloud Run service, open it.

    gcpdeploy create <app>

`ship` only updates a service that exists. This is the other half, for the
shape every new app on this domain shares (Spar, Snapquote, ...):

  - runs as <service>-run@, which must already exist. Creating it is Erik's step
    (scripts/new-app-accounts.sh) because the deployer has no IAM-admin rights,
    and this refuses rather than falling back to some other account: borrowing
    another app's identity means borrowing its data access.
  - its own Firestore database, created here if missing (Native, us-central1).
  - env: project, database, identity database; secrets anthropic-api-key and
    identity-session-secret. Nothing else - an app that needs more gets it
    added to the live service, and `ship` carries it from then on.
  - cpuIdle: true, minInstanceCount 0 (DEPLOY.md -> "Creating a service").
  - allUsers may invoke: the app's own sign-in is the gate.

The token stays inside google-auth's AuthorizedSession; it is never written
out or handed to a shell.
"""
import io
import json
import os
import subprocess
import sys
import tarfile
import time

from google.oauth2 import service_account
from google.auth.transport.requests import AuthorizedSession

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, 'apps.json')))
P, R = CFG['project'], CFG['region']


def die(msg):
    print(f'error: {msg}', file=sys.stderr)
    sys.exit(1)


def say(msg):
    print(f'==> {msg}', flush=True)


def session(key):
    creds = service_account.Credentials.from_service_account_file(
        key, scopes=['https://www.googleapis.com/auth/cloud-platform'])
    return AuthorizedSession(creds)


def main():
    if len(sys.argv) < 3:
        die('usage: create_service.py <key.json> <app>')
    key, app = sys.argv[1], sys.argv[2]
    a = CFG['apps'].get(app) or die(f'{app} is not in apps.json')
    svc, db = a['service'], a['db']
    ctx = os.path.join(os.environ.get('REPO_ROOT', '/home/user'), a['repo'])
    if not os.path.isfile(os.path.join(ctx, 'Dockerfile')):
        die(f'no Dockerfile at {ctx}')
    s = session(key)
    base = f'https://run.googleapis.com/v2/projects/{P}/locations/{R}/services'

    if s.get(f'{base}/{svc}').status_code == 200:
        die(f'service {svc} already exists - use `gcpdeploy ship {app}`.')

    account = f'{svc}-run@{P}.iam.gserviceaccount.com'
    r = s.get(f'https://iam.googleapis.com/v1/projects/{P}/serviceAccounts/{account}')
    if r.status_code != 200:
        die(f'runtime account {account} does not exist.\n'
            f'Erik runs, in Cloud Shell:  ./scripts/new-app-accounts.sh {svc}')

    top = subprocess.run(['git', '-C', ctx, 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip()
    if subprocess.run(['git', '-C', top, 'status', '--porcelain'], capture_output=True, text=True).stdout.strip():
        die('uncommitted changes. Commit and push first - a deployed image that matches no commit is not reproducible.')
    sha = subprocess.run(['git', '-C', top, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()

    # Database first, so a revision never boots against one that is missing.
    if db:
        r = s.get(f'https://firestore.googleapis.com/v1/projects/{P}/databases/{db}')
        if r.status_code == 404:
            say(f'creating Firestore database {db}')
            r = s.post(f'https://firestore.googleapis.com/v1/projects/{P}/databases?databaseId={db}',
                       json={'type': 'FIRESTORE_NATIVE', 'locationId': R})
            if r.status_code >= 300:
                die(f'database create failed: {r.text[:300]}')
            for _ in range(30):
                if s.get(f'https://firestore.googleapis.com/v1/projects/{P}/databases/{db}').status_code == 200:
                    break
                time.sleep(5)

    say(f'{app} @ {sha}: packaging')
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        def skip(ti):
            parts = ti.name.split('/')
            return None if ('node_modules' in parts or '.git' in parts) else ti
        tar.add(ctx, arcname='.', filter=skip)
    obj = f'{app}-{int(time.time())}.tar.gz'
    r = s.post(f'https://storage.googleapis.com/upload/storage/v1/b/{CFG["build_bucket"]}/o?uploadType=media&name={obj}',
               data=buf.getvalue(), headers={'Content-Type': 'application/gzip'})
    if r.status_code >= 300:
        die(f'upload failed: {r.text[:300]}')

    img = f'{R}-docker.pkg.dev/{P}/{CFG["registry"]}/{svc}'
    say('building')
    r = s.post(f'https://cloudbuild.googleapis.com/v1/projects/{P}/locations/{R}/builds', json={
        'source': {'storageSource': {'bucket': CFG['build_bucket'], 'object': obj}},
        'steps': [{'name': 'gcr.io/cloud-builders/docker', 'args': ['build', '-t', f'{img}:{sha}', '.']}],
        'images': [f'{img}:{sha}'],
        'options': {'logging': 'CLOUD_LOGGING_ONLY'},
    })
    if r.status_code >= 300:
        die(f'build submit failed: {r.text[:300]}')
    bid = r.json()['metadata']['build']['id']
    while True:
        b = s.get(f'https://cloudbuild.googleapis.com/v1/projects/{P}/locations/{R}/builds/{bid}').json()
        if b.get('status') not in ('QUEUED', 'WORKING'):
            break
        time.sleep(15)
    if b.get('status') != 'SUCCESS':
        die(f'build {b.get("status")} ({bid})')
    digest = b['results']['images'][0]['digest']
    say(f'built {digest[:19]}')

    env = [
        {'name': 'GOOGLE_CLOUD_PROJECT', 'value': P},
        {'name': 'FIRESTORE_DATABASE_ID', 'value': db},
        {'name': 'IDENTITY_DATABASE_ID', 'value': 'identity'},
        {'name': 'ANTHROPIC_API_KEY', 'valueSource': {'secretKeyRef': {'secret': 'anthropic-api-key', 'version': 'latest'}}},
        {'name': 'IDENTITY_SESSION_SECRET', 'valueSource': {'secretKeyRef': {'secret': 'identity-session-secret', 'version': 'latest'}}},
    ]
    body = {
        'ingress': 'INGRESS_TRAFFIC_ALL',
        'template': {
            'serviceAccount': account,
            'scaling': {'minInstanceCount': 0, 'maxInstanceCount': 3},
            'timeout': '300s',
            'containers': [{
                'image': f'{img}@{digest}',
                'ports': [{'containerPort': 8080}],
                'env': env,
                'resources': {'limits': {'cpu': '1', 'memory': '512Mi'}, 'cpuIdle': True, 'startupCpuBoost': True},
            }],
        },
    }
    say(f'creating service {svc}')
    r = s.post(f'{base}?serviceId={svc}', json=body)
    if r.status_code >= 300:
        die(f'service create failed: {r.text[:500]}')

    for _ in range(60):
        d = s.get(f'{base}/{svc}').json()
        c = d.get('terminalCondition', {})
        if c.get('state') in ('CONDITION_SUCCEEDED', 'CONDITION_FAILED'):
            break
        time.sleep(10)
    if c.get('state') != 'CONDITION_SUCCEEDED':
        die(f'revision did not become ready: {c.get("state")} {c.get("message", "")}')

    r = s.post(f'{base}/{svc}:setIamPolicy', json={'policy': {'bindings': [{'role': 'roles/run.invoker', 'members': ['allUsers']}]}})
    if r.status_code >= 300:
        die(f'service is up but not public: {r.text[:300]}')
    say(f'live: {d.get("uri")}')
    print('\nThe proxy blocks *.run.app from this container, so you cannot curl it.'
          '\nFrom now on: gcpdeploy ship ' + app)


if __name__ == '__main__':
    main()
