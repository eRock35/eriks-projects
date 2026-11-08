#!/usr/bin/env python3
"""Lab Pulse: what the iPhone builds, TestFlight and CI are doing, as one file.

    python3 scripts/pulse.py --out pulse.json     gather, validate, write
    python3 scripts/pulse.py --check pulse.json   validate a file, write nothing

Run by .github/workflows/pulse.yml every three hours. The Lab's /pulse page
(challenge/pulse.js) reads the file from this repo's `pulse-data` branch and
validates it again, field by field: it never trusts what is written here.

Read-only everywhere:
  - GitHub's Actions API with the job's own token (actions: read): the latest
    ios.yml runs and their per-app jobs (the matrix job names ARE the app
    slugs), the last upload per app, and the latest ci.yml run on main. For a
    failed job it reads the job's log once, only to put the failure into one
    word (`agreement`, `auth`, `certificate-limit`, `secrets`, `other`); no
    log text is kept.
  - App Store Connect GETs through asc_read.py (asc_signing's key and token):
    each app found by bundle ID, its newest build's version, build number,
    processing state, upload and expiry dates and beta state.

Never written, and checked before writing (`validate`, `leaks`): the Team ID,
the key id, the issuer id, any token, any email address, any App Store
Connect numeric id. Every string in the file is an enum, a date, a short
pattern-checked value or a github.com Actions URL. An App Store Connect
failure (the 2026-11-01 agreement 403, a bad key) is recorded as
`{"ok": false, "reason": ...}` and the file is still written.
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import asc_read  # noqa: E402

SCHEMA = 1
GITHUB_API = 'https://api.github.com'
REPO = 'eRock35/eriks-projects'
GENERATE = HERE / 'generate.mjs'
PLAN_JOB = 'Check secrets, pick apps'   # ios.yml's plan job name; check.py holds it
UPLOAD_STEP = 'Upload to TestFlight'    # ios.yml's upload step name; check.py holds it
CHECK_ONLY = 'check only'               # in ios.yml's run-name for a check_only run
RUNS_TO_SCAN = 30
LOG_LIMIT = 3 * 1024 * 1024

CONCLUSIONS = ('success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required',
               'neutral', 'stale', 'startup_failure', 'in_progress', 'unknown')
EVENTS = ('schedule', 'workflow_dispatch', 'push', 'pull_request', 'workflow_run', 'unknown')
FAILURES = ('agreement', 'auth', 'certificate-limit', 'secrets', 'other')
ASC_REASONS = ('agreement', 'auth', 'error', 'unset')
PROCESSING = ('PROCESSING', 'FAILED', 'INVALID', 'VALID', 'UNKNOWN')
EXTERNAL = ('PROCESSING', 'PROCESSING_EXCEPTION', 'MISSING_EXPORT_COMPLIANCE', 'READY_FOR_BETA_TESTING',
            'IN_BETA_TESTING', 'EXPIRED', 'READY_FOR_BETA_SUBMISSION', 'IN_EXPORT_COMPLIANCE_REVIEW',
            'WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW', 'BETA_REJECTED', 'BETA_APPROVED', 'UNKNOWN')
INTERNAL = ('PROCESSING', 'PROCESSING_EXCEPTION', 'MISSING_EXPORT_COMPLIANCE', 'READY_FOR_BETA_TESTING',
            'IN_BETA_TESTING', 'EXPIRED', 'IN_EXPORT_COMPLIANCE_REVIEW', 'UNKNOWN')

ISO = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
RUN_URL = re.compile(r'^https://github\.com/eRock35/eriks-projects/actions/runs/\d{1,20}(?:/job/\d{1,20})?$')
STEP = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ,.'()&+/-]{0,79}$")
SLUG = re.compile(r'^[a-z]{2,20}$')
BUNDLE = re.compile(r'^com\.strongtechnicalconsulting\.[a-z]{2,20}$')
VERSION = re.compile(r'^\d{1,3}(?:\.\d{1,3}){1,2}$')
# Six digits at most, so an App Store Connect numeric id (ten digits) can never
# pass as a build number. Builds are numbered by the workflow's run number.
BUILD_NO = re.compile(r'^\d{1,6}(?:\.\d{1,3})?$')


def now_utc():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_time(v):
    """Any ISO 8601 time GitHub or Apple sends -> an aware UTC datetime, or None."""
    if not isinstance(v, str) or not v:
        return None
    try:
        t = dt.datetime.fromisoformat(v.replace('Z', '+00:00'))
    except ValueError:
        return None
    if t.tzinfo is None:
        return None
    return t.astimezone(dt.timezone.utc).replace(microsecond=0)


def iso_or_none(v):
    t = parse_time(v)
    return iso(t) if t else None


def next_scheduled(now):
    """ios.yml's schedule, '23 9 1 * *': the next 1st of a month at 09:23 UTC."""
    t = now.replace(day=1, hour=9, minute=23, second=0, microsecond=0)
    if t <= now:
        t = (t.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    return t


def iphone_apps():
    """(slug, name, bundle ID) per app, in generate.mjs's order: its APPS table."""
    text = GENERATE.read_text()
    found = re.findall(r"^  (\w+): \{\s*\n\s*name: '([^']+)',\s*\n\s*bundleId: '([^']+)'", text, re.M)
    return [(s, n, b) for s, n, b in found if SLUG.match(s) and BUNDLE.match(b)]


def enum(v, allowed, fallback):
    return v if v in allowed else fallback


def conclusion_of(obj):
    if obj.get('status') != 'completed':
        return 'in_progress'
    return enum(obj.get('conclusion'), CONCLUSIONS, 'unknown')


# ---------------- GitHub ----------------

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - keep the 302 for the caller
        return None


def _http(url, headers, follow=True, limit=None):
    """(status, headers, body bytes). Replaced by the tests."""
    opener = urllib.request.build_opener(*([] if follow else [NoRedirect()]))
    req = urllib.request.Request(url, headers=headers)
    try:
        with opener.open(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read(limit + 1 if limit else -1)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), b''


HTTP = _http


def gh_headers():
    h = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
         'User-Agent': 'lab-pulse'}
    tok = os.environ.get('GITHUB_TOKEN')
    if tok:
        h['Authorization'] = 'Bearer ' + tok
    return h


class GitHubError(Exception):
    pass


def gh(path):
    status, _, body = HTTP(GITHUB_API + path, gh_headers())
    if status != 200:
        raise GitHubError(f'GET {path.split("?")[0]} -> {status}')
    return json.loads(body)


def classify_log(text):
    """A failed job's log -> one word. Nothing else of the log is kept."""
    if re.search(r'Program License Agreement|PLA Update|title=Apple agreement', text, re.I):
        return 'agreement'
    if re.search(r'title=Certificate limit', text):
        return 'certificate-limit'
    if re.search(r'title=(Missing secrets|APPSTORE_KEY_P8|APPLE_TEAM_ID)::', text):
        return 'secrets'
    if re.search(r'-> 401\b|title=App Store Connect key refused|title=App Store Connect access refused|NOT_AUTHORIZED', text):
        return 'auth'
    return 'other'


def job_failure(job_id):
    """Read a failed job's log once (GitHub answers with a redirect to storage,
    which is fetched without our token) and classify it; None if unreadable."""
    status, headers, _ = HTTP(f'{GITHUB_API}/repos/{REPO}/actions/jobs/{job_id}/logs', gh_headers(), follow=False)
    loc = headers.get('Location') or headers.get('location')
    if status in (301, 302, 303, 307, 308) and isinstance(loc, str) and loc.startswith('https://'):
        status, _, body = HTTP(loc, {'User-Agent': 'lab-pulse'}, limit=LOG_LIMIT)
    else:
        return None
    if status != 200:
        return None
    return classify_log(body[-LOG_LIMIT:].decode('utf-8', errors='replace'))


def run_targets(run, slugs):
    """Which apps a run was asked to build: its run-name ends ': <app>' or ': all'."""
    title = str(run.get('display_title') or '')
    m = re.search(r':\s*([a-z]+)\s*$', title)
    if m and m.group(1) in slugs:
        return {m.group(1)}
    return set(slugs)


def run_summary(run):
    return {
        'number': run.get('run_number') if isinstance(run.get('run_number'), int) else None,
        'event': enum(run.get('event'), EVENTS, 'unknown'),
        'conclusion': conclusion_of(run),
        'at': iso_or_none(run.get('run_started_at') or run.get('created_at')),
        'url': run.get('html_url') if RUN_URL.match(str(run.get('html_url'))) else None,
        'checkOnly': CHECK_ONLY in str(run.get('display_title') or '').lower(),
    }


def failed_step(job):
    for s in job.get('steps') or []:
        if s.get('conclusion') == 'failure' and STEP.match(str(s.get('name'))):
            return s['name']
    return None


def job_result(run, job, failures, stopped_in_plan=False):
    c = conclusion_of(job)
    out = {
        'run': run.get('run_number'),
        'conclusion': c,
        'at': iso_or_none(job.get('completed_at') or job.get('started_at') or run.get('created_at')),
        'url': job.get('html_url') if RUN_URL.match(str(job.get('html_url'))) else None,
        'failedStep': failed_step(job) if c == 'failure' else None,
        'failure': None,
        'stoppedInPlan': stopped_in_plan,
    }
    if c == 'failure' and isinstance(job.get('id'), int):
        if job['id'] not in failures:
            failures[job['id']] = job_failure(job['id'])
        out['failure'] = failures[job['id']]
    return out


def uploaded(job):
    return any(s.get('name') == UPLOAD_STEP and s.get('conclusion') == 'success' for s in job.get('steps') or [])


def gather_ios(slugs):
    """lastRun, and per app its latest result and its latest upload."""
    runs = gh(f'/repos/{REPO}/actions/workflows/ios.yml/runs?per_page={RUNS_TO_SCAN}').get('workflow_runs') or []
    last = run_summary(runs[0]) if runs else None
    latest, upload, failures = {}, {}, {}
    for run in runs:
        if len(latest) == len(slugs) and len(upload) == len(slugs):
            break
        if CHECK_ONLY in str(run.get('display_title') or '').lower():
            continue  # a check_only run builds nothing, so it is no app's result
        jobs = gh(f"/repos/{REPO}/actions/runs/{run['id']}/jobs?per_page=100&filter=latest").get('jobs') or []
        by_name = {j.get('name'): j for j in jobs}
        plan = by_name.get(PLAN_JOB)
        targets = run_targets(run, slugs)
        for slug in slugs:
            job = by_name.get(slug)
            if job is None:
                # Not built: stopped in the plan job (the guard, a missing secret)?
                if slug not in latest and slug in targets and plan and conclusion_of(plan) == 'failure':
                    latest[slug] = job_result(run, plan, failures, stopped_in_plan=True)
                continue
            if slug not in latest:
                latest[slug] = job_result(run, job, failures)
            if slug not in upload and uploaded(job):
                upload[slug] = {
                    'run': run.get('run_number'),
                    'at': iso_or_none(job.get('completed_at') or run.get('created_at')),
                    'url': job.get('html_url') if RUN_URL.match(str(job.get('html_url'))) else None,
                }
    return last, latest, upload


def gather_ci():
    runs = gh(f'/repos/{REPO}/actions/workflows/ci.yml/runs?branch=main&status=completed&per_page=1').get('workflow_runs') or []
    if not runs:
        return None
    run = runs[0]
    jobs = gh(f"/repos/{REPO}/actions/runs/{run['id']}/jobs?per_page=100&filter=latest").get('jobs') or []
    return {
        'workflow': 'ci.yml',
        'branch': 'main',
        'run': run.get('run_number'),
        'conclusion': conclusion_of(run),
        'at': iso_or_none(run.get('updated_at') or run.get('created_at')),
        'url': run.get('html_url') if RUN_URL.match(str(run.get('html_url'))) else None,
        'jobs': [{'name': j['name'], 'conclusion': conclusion_of(j),
                  'failedStep': failed_step(j) if conclusion_of(j) == 'failure' else None}
                 for j in jobs[:20] if STEP.match(str(j.get('name')))],
    }


# ---------------- App Store Connect (read-only) ----------------

def asc_configured():
    key = pathlib.Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'AuthKey.p8'
    return bool(os.environ.get('APPSTORE_KEY_ID') and os.environ.get('APPSTORE_ISSUER_ID') and key.is_file())


def asc_reason(e):
    r = asc_read.classify(e.status, e.text)
    return {'agreement': 'agreement', 'auth': 'auth', 'forbidden': 'auth'}.get(r, 'error')


def newest_build(app_id, now):
    """Apple's newest build for an app -> what the page shows; no ids kept."""
    res = asc_read.get(f'/builds?filter[app]={app_id}&sort=-uploadedDate&limit=1'
                       '&include=buildBetaDetail,preReleaseVersion')
    builds = res.get('data') or []
    if not builds:
        return None
    b = builds[0]
    inc = {(x.get('type'), x.get('id')): x for x in res.get('included') or []}
    rel = b.get('relationships') or {}
    detail = inc.get(('buildBetaDetails', ((rel.get('buildBetaDetail') or {}).get('data') or {}).get('id'))) or {}
    ver = inc.get(('preReleaseVersions', ((rel.get('preReleaseVersion') or {}).get('data') or {}).get('id'))) or {}
    a = b.get('attributes') or {}
    da = detail.get('attributes') or {}
    expires = parse_time(a.get('expirationDate'))
    version = (ver.get('attributes') or {}).get('version')
    number = a.get('version')
    return {
        'version': version if isinstance(version, str) and VERSION.match(version) else None,
        'number': number if isinstance(number, str) and BUILD_NO.match(number) else None,
        'processingState': enum(a.get('processingState'), PROCESSING, 'UNKNOWN'),
        'uploadedAt': iso_or_none(a.get('uploadedDate')),
        'expiresAt': iso(expires) if expires else None,
        'expired': a.get('expired') is True,
        'daysToExpiry': max(-999, min(999, (expires - now).days)) if expires else None,
        'external': enum(da.get('externalBuildState'), EXTERNAL, 'UNKNOWN') if da else None,
        'internal': enum(da.get('internalBuildState'), INTERNAL, 'UNKNOWN') if da else None,
    }


def gather_asc(apps, now):
    """(top-level {ok, reason}, {slug: per-app asc}). An agreement or key
    failure stops the asking: it would be the same answer for every app."""
    if not asc_configured():
        off = {'ok': False, 'reason': 'unset'}
        return dict(off), {s: dict(off) for s, _, _ in apps}
    top, per = {'ok': True}, {}
    for slug, _, bundle in apps:
        try:
            res = asc_read.get(f'/apps?filter[bundleId]={bundle}&limit=50')
            app = next((x for x in res.get('data') or []
                        if (x.get('attributes') or {}).get('bundleId') == bundle), None)
            if not app:
                per[slug] = {'ok': True, 'found': False, 'build': None}
                continue
            per[slug] = {'ok': True, 'found': True, 'build': newest_build(app['id'], now)}
        except asc_read.AscError as e:
            reason = asc_reason(e)
            per[slug] = {'ok': False, 'reason': reason}
            if top.get('ok') or reason != 'error':
                top = {'ok': False, 'reason': reason}
            if reason in ('agreement', 'auth'):
                for s, _, _ in apps:
                    per.setdefault(s, {'ok': False, 'reason': reason})
                break
    return top, per


# ---------------- the document ----------------

def build_doc(now=None):
    now = now or now_utc()
    apps = iphone_apps()
    slugs = [s for s, _, _ in apps]
    nxt = next_scheduled(now)
    github_ok = True
    last, latest, upload, ci = None, {}, {}, None
    try:
        last, latest, upload = gather_ios(slugs)
    except (GitHubError, ValueError, KeyError, TypeError):
        github_ok = False
    try:
        ci = gather_ci()
    except (GitHubError, ValueError, KeyError, TypeError):
        github_ok = False
    top, per = gather_asc(apps, now)
    rows = []
    for slug, _, bundle in apps:
        asc = per.get(slug) or {'ok': False, 'reason': 'error'}
        build = asc.get('build') if asc.get('ok') else None
        exp = parse_time(build.get('expiresAt')) if build else None
        rows.append({
            'slug': slug,
            'bundleId': bundle,
            'latest': latest.get(slug),
            'lastUpload': upload.get(slug),
            'asc': asc,
            'expiresBeforeNextBuild': bool(exp and exp < nxt),
        })
    return {
        'schema': SCHEMA,
        'generatedAt': iso(now),
        'github': {'ok': github_ok},
        'asc': top,
        'iphone': {'lastRun': last, 'nextScheduled': iso(nxt), 'apps': rows},
        'ci': ci,
    }


# ---------------- the schema: every field, strictly ----------------

def validate(doc):
    """[] when `doc` is exactly what /pulse expects; else what is wrong."""
    errs = []

    def need(cond, where):
        if not cond:
            errs.append(where)
        return cond

    def keys(obj, allowed, where):
        """True only when every allowed key is there; unknown keys are errors too."""
        if not need(isinstance(obj, dict), where + ': not an object'):
            return False
        extra = set(obj) - set(allowed)
        need(not extra, f'{where}: unknown keys {sorted(extra)}')
        missing = set(allowed) - set(obj)
        return need(not missing, f'{where}: missing keys {sorted(missing)}')

    def is_int(v, lo, hi):
        return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi

    def is_iso(v):
        return isinstance(v, str) and bool(ISO.match(v)) and parse_time(v) is not None

    def opt(v, test):
        return v is None or test(v)

    def run_ref(r, where, allowed):
        if not keys(r, allowed, where):
            return False
        need(is_int(r['run'], 1, 10**7), where + '.run')
        if 'conclusion' in allowed:
            need(r['conclusion'] in CONCLUSIONS, where + '.conclusion')
        need(opt(r['at'], is_iso), where + '.at')
        need(opt(r['url'], lambda u: isinstance(u, str) and bool(RUN_URL.match(u))), where + '.url')
        return True

    if not keys(doc, ('schema', 'generatedAt', 'github', 'asc', 'iphone', 'ci'), 'doc'):
        return errs
    need(doc['schema'] == SCHEMA, 'schema')
    need(is_iso(doc['generatedAt']), 'generatedAt')
    if keys(doc['github'], ('ok',), 'github'):
        need(isinstance(doc['github']['ok'], bool), 'github.ok')

    def asc_state(a, where, top=False):
        if not isinstance(a, dict) or not isinstance(a.get('ok'), bool):
            return need(False, where)
        if not a['ok']:
            if keys(a, ('ok', 'reason'), where):
                need(a['reason'] in ASC_REASONS, where + '.reason')
            return None
        if top:
            return keys(a, ('ok',), where)
        if not keys(a, ('ok', 'found', 'build'), where):
            return None
        need(isinstance(a['found'], bool), where + '.found')
        b = a['build']
        if b is None:
            return None
        w = where + '.build'
        if keys(b, ('version', 'number', 'processingState', 'uploadedAt', 'expiresAt', 'expired',
                    'daysToExpiry', 'external', 'internal'), w):
            need(opt(b['version'], lambda v: isinstance(v, str) and bool(VERSION.match(v))), w + '.version')
            need(opt(b['number'], lambda v: isinstance(v, str) and bool(BUILD_NO.match(v))), w + '.number')
            need(b['processingState'] in PROCESSING, w + '.processingState')
            need(opt(b['uploadedAt'], is_iso), w + '.uploadedAt')
            need(opt(b['expiresAt'], is_iso), w + '.expiresAt')
            need(isinstance(b['expired'], bool), w + '.expired')
            need(opt(b['daysToExpiry'], lambda v: is_int(v, -999, 999)), w + '.daysToExpiry')
            need(b['external'] is None or b['external'] in EXTERNAL, w + '.external')
            need(b['internal'] is None or b['internal'] in INTERNAL, w + '.internal')
        return None

    asc_state(doc['asc'], 'asc', top=True)

    ip = doc['iphone']
    if keys(ip, ('lastRun', 'nextScheduled', 'apps'), 'iphone'):
        need(is_iso(ip['nextScheduled']), 'iphone.nextScheduled')
        lr = ip['lastRun']
        if lr is not None and keys(lr, ('number', 'event', 'conclusion', 'at', 'url', 'checkOnly'), 'iphone.lastRun'):
            need(opt(lr['number'], lambda v: is_int(v, 1, 10**7)), 'iphone.lastRun.number')
            need(lr['event'] in EVENTS, 'iphone.lastRun.event')
            need(lr['conclusion'] in CONCLUSIONS, 'iphone.lastRun.conclusion')
            need(opt(lr['at'], is_iso), 'iphone.lastRun.at')
            need(opt(lr['url'], lambda u: isinstance(u, str) and bool(RUN_URL.match(u))), 'iphone.lastRun.url')
            need(isinstance(lr['checkOnly'], bool), 'iphone.lastRun.checkOnly')
        if need(isinstance(ip['apps'], list) and len(ip['apps']) <= 10, 'iphone.apps'):
            seen = set()
            for i, a in enumerate(ip['apps']):
                w = f'iphone.apps[{i}]'
                if not keys(a, ('slug', 'bundleId', 'latest', 'lastUpload', 'asc', 'expiresBeforeNextBuild'), w):
                    continue
                need(isinstance(a['slug'], str) and bool(SLUG.match(a['slug'])) and a['slug'] not in seen, w + '.slug')
                seen.add(a['slug'])
                need(isinstance(a['bundleId'], str) and a['bundleId'] == f"com.strongtechnicalconsulting.{a['slug']}", w + '.bundleId')
                lt = a['latest']
                if lt is not None and run_ref(lt, w + '.latest', ('run', 'conclusion', 'at', 'url', 'failedStep', 'failure', 'stoppedInPlan')):
                    need(opt(lt['failedStep'], lambda v: isinstance(v, str) and bool(STEP.match(v))), w + '.latest.failedStep')
                    need(lt['failure'] is None or lt['failure'] in FAILURES, w + '.latest.failure')
                    need(isinstance(lt['stoppedInPlan'], bool), w + '.latest.stoppedInPlan')
                if a['lastUpload'] is not None:
                    run_ref(a['lastUpload'], w + '.lastUpload', ('run', 'at', 'url'))
                asc_state(a['asc'], w + '.asc')
                need(isinstance(a['expiresBeforeNextBuild'], bool), w + '.expiresBeforeNextBuild')

    ci = doc['ci']
    if ci is not None and keys(ci, ('workflow', 'branch', 'run', 'conclusion', 'at', 'url', 'jobs'), 'ci'):
        need(ci['workflow'] == 'ci.yml', 'ci.workflow')
        need(ci['branch'] == 'main', 'ci.branch')
        need(is_int(ci['run'], 1, 10**7), 'ci.run')
        need(ci['conclusion'] in CONCLUSIONS, 'ci.conclusion')
        need(opt(ci['at'], is_iso), 'ci.at')
        need(opt(ci['url'], lambda u: isinstance(u, str) and bool(RUN_URL.match(u))), 'ci.url')
        if need(isinstance(ci['jobs'], list) and len(ci['jobs']) <= 20, 'ci.jobs'):
            for i, j in enumerate(ci['jobs']):
                w = f'ci.jobs[{i}]'
                if keys(j, ('name', 'conclusion', 'failedStep'), w):
                    need(isinstance(j['name'], str) and bool(STEP.match(j['name'])), w + '.name')
                    need(j['conclusion'] in CONCLUSIONS, w + '.conclusion')
                    need(opt(j['failedStep'], lambda v: isinstance(v, str) and bool(STEP.match(v))), w + '.failedStep')
    return errs


def leaks(text):
    """Belt and braces over the serialised file: nothing secret-shaped at all."""
    found = []
    if asc_read.EMAIL.search(text):
        found.append('an email address')
    if re.search(r'eyJ[A-Za-z0-9_-]{8,}', text):
        found.append('a token')
    if 'PRIVATE KEY' in text:
        found.append('a key')
    if re.search(r'\b[A-Z0-9]{10}\.com\.strongtechnicalconsulting\.', text):
        found.append('a Team ID')
    for name in ('APPSTORE_KEY_ID', 'APPSTORE_ISSUER_ID', 'APPLE_TEAM_ID', 'GITHUB_TOKEN'):
        v = os.environ.get(name) or ''
        if len(v) >= 6 and v in text:
            found.append(name)
    return found


def serialise(doc):
    return json.dumps(doc, indent=1, sort_keys=True, ensure_ascii=True) + '\n'


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument('--out', help='gather, validate and write pulse.json here')
    g.add_argument('--check', help='validate an existing pulse.json; write nothing')
    args = p.parse_args(argv)
    if args.check:
        text = pathlib.Path(args.check).read_text()
        try:
            doc = json.loads(text)
        except ValueError:
            print('::error title=Lab Pulse::pulse.json is not JSON.')
            return 1
        problems = validate(doc) + leaks(text)
    else:
        doc = build_doc()
        text = serialise(doc)
        problems = validate(doc) + leaks(text)
    if problems:
        print('::error title=Lab Pulse::pulse.json failed its schema, nothing written: ' + '; '.join(problems[:10]))
        return 1
    if args.out:
        pathlib.Path(args.out).write_text(text)
        asc = doc['asc']
        print(f"pulse.json: {len(doc['iphone']['apps'])} iPhone apps, GitHub "
              f"{'read' if doc['github']['ok'] else 'NOT read'}, App Store Connect "
              f"{'read' if asc['ok'] else 'not read (' + asc['reason'] + ')'}.")
    else:
        print('pulse.json is valid.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
