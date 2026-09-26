#!/usr/bin/env python3
"""Tokens (and agent time) spent building a Challenge Lab app.

Reads Claude Code transcripts (agent-*.jsonl) and sums each assistant
message's usage once (streamed lines repeat the same message id).

  python3 scripts/token-ledger.py <agent.jsonl> [...]          one line per file
  python3 scripts/token-ledger.py --workflow <workflow dir>    grouped by phase

"in" is everything the model read: fresh input + cache writes + cache reads.
Cache reads are the agent re-reading its own conversation each step; they
are most of the total and cost about a tenth of fresh input, so both are shown.

Build stats for the lab page (challenge/build-stats.json)
---------------------------------------------------------

  python3 scripts/token-ledger.py --stats <slug> <agent.jsonl> [...] [--exact]
  python3 scripts/token-ledger.py --stats <slug> --workflow <dir> [--exact]
  python3 scripts/token-ledger.py --stats <slug> --estimate \
      --in 30e6 --out 200e3 --agents 1 --agent-min 45 [--note "..."]

Each writes one app's row into challenge/build-stats.json and recomputes the
totals. Re-running for the same slug replaces that row, so it is safe to run
twice. Add --dry-run to print the row without writing, --file to write
somewhere else, and --note for a line of provenance.

A row is {in, cached, out, agents, agentMs, wallMs, exact, note}:
  in       fresh input + cache writes + cache reads
  cached   cache reads alone (the agents re-reading their own work); null on
           an estimate that gives no --cached
  out      output tokens
  agents   transcripts counted (one per agent)
  agentMs  sum over agents of (last - first timestamp in its transcript)
  wallMs   first timestamp to last across all of them (for one agent, the
           same as agentMs; for a workflow, shorter, because agents overlap)
  exact    counted from transcripts (true) or an estimate (false)
"""
import datetime, glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
STATS_FILE = os.path.join(HERE, '..', 'challenge', 'build-stats.json')


def _ts(s):
    try:
        return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000
    except (ValueError, AttributeError):
        return None


def usage(path):
    seen = {}
    first = last = None
    for line in open(path):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if not isinstance(o, dict):
            continue
        ms = _ts(o.get('timestamp'))
        if ms is not None:
            first = ms if first is None else min(first, ms)
            last = ms if last is None else max(last, ms)
        m = o.get('message') or {}
        if o.get('type') == 'assistant' and m.get('usage') and m.get('id'):
            seen[m['id']] = m['usage']
    t = {'fresh': 0, 'cache_write': 0, 'cache_read': 0, 'out': 0}
    for u in seen.values():
        t['fresh'] += u.get('input_tokens', 0)
        t['cache_write'] += u.get('cache_creation_input_tokens', 0)
        t['cache_read'] += u.get('cache_read_input_tokens', 0)
        t['out'] += u.get('output_tokens', 0)
    t['in'] = t['fresh'] + t['cache_write'] + t['cache_read']
    t['first'], t['last'] = first, last
    return t


def show(label, t):
    print(f"{label:<28} in {t['in']/1e6:8.1f}M  (cached {t['cache_read']/1e6:6.1f}M)  out {t['out']/1e3:8.1f}K")


def workflow_files(d):
    # agent-*.jsonl only: a workflow dir also holds journal.jsonl, which is
    # the orchestrator's log, not an agent.
    return sorted(glob.glob(os.path.join(d, 'agent-*.jsonl')))


def measure(paths):
    """Sum a set of agent transcripts into one build-stats row."""
    row = {'in': 0, 'cached': 0, 'out': 0, 'agents': 0, 'agentMs': 0, 'wallMs': 0}
    lo = hi = None
    for p in paths:
        t = usage(p)
        row['in'] += t['in']
        row['cached'] += t['cache_read']
        row['out'] += t['out']
        row['agents'] += 1
        if t['first'] is not None:
            row['agentMs'] += int(round(t['last'] - t['first']))
            lo = t['first'] if lo is None else min(lo, t['first'])
            hi = t['last'] if hi is None else max(hi, t['last'])
    if lo is not None:
        row['wallMs'] = int(round(hi - lo))
    return row


TOTAL_KEYS = ('in', 'cached', 'out', 'agents', 'agentMs', 'wallMs')


def totals(apps):
    t = dict.fromkeys(TOTAL_KEYS, 0)
    known_in = 0
    for r in apps.values():
        for k in TOTAL_KEYS:
            t[k] += int(r.get(k) or 0)
        if r.get('cached') is not None:
            known_in += int(r.get('in') or 0)
    t['apps'] = len(apps)
    t['estimated'] = sum(1 for r in apps.values() if not r.get('exact'))
    # The cached share is taken over the rows that know theirs: an estimate
    # with no cache split would otherwise read as 0% cached and drag it down.
    t['cachedShare'] = round(t['cached'] / known_in, 4) if known_in else None
    return t


def load(path):
    try:
        with open(path) as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get('apps'), dict):
            return d
    except (OSError, ValueError):
        pass
    return {'apps': {}}


def save(path, d):
    d['updated'] = datetime.date.today().isoformat()
    d['totals'] = totals(d['apps'])
    out = {'_about': d.get('_about') or 'Written by scripts/token-ledger.py --stats. Apps only; totals are the sum of the apps. See challenge/TOKENS.md.',
           'updated': d['updated'], 'apps': d['apps'], 'totals': d['totals']}
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(out, f, indent=2)
        f.write('\n')
    os.replace(tmp, path)


def take(args, flag, cast=str, default=None):
    if flag in args:
        i = args.index(flag)
        v = args[i + 1]
        del args[i:i + 2]
        return cast(v)
    return default


def stats(args):
    slug = args.pop(0)
    if not slug.replace('-', '').isalnum() or slug != slug.lower():
        sys.exit(f'bad slug: {slug}')
    path = take(args, '--file', default=STATS_FILE)
    note = take(args, '--note')
    dry = '--dry-run' in args
    estimate = '--estimate' in args
    args = [a for a in args if a not in ('--dry-run', '--estimate', '--exact')]
    if estimate:
        row = {
            'in': int(take(args, '--in', float, 0)),
            'cached': take(args, '--cached', float, None),
            'out': int(take(args, '--out', float, 0)),
            'agents': int(take(args, '--agents', float, 1)),
        }
        mins = take(args, '--agent-min', float, 0)
        row['agentMs'] = int(mins * 60000)
        row['wallMs'] = int(take(args, '--wall-min', float, mins) * 60000)
        if args:
            sys.exit('unexpected with --estimate: ' + ' '.join(args))
        if row['cached'] is not None:
            row['cached'] = int(row['cached'])
        row['exact'] = False
    else:
        wf = take(args, '--workflow')
        paths = (workflow_files(wf) if wf else []) + args
        if not paths:
            sys.exit('give agent transcripts, --workflow <dir>, or --estimate')
        missing = [p for p in paths if not os.path.isfile(p)]
        if missing:
            sys.exit('not found: ' + ', '.join(missing))
        row = measure(paths)
        row['exact'] = True
    row['note'] = note or ''
    if dry:
        print(json.dumps({slug: row}, indent=2))
        return
    d = load(path)
    d['apps'][slug] = row
    save(path, d)
    print(json.dumps({slug: row, 'totals': d['totals']}, indent=2))


if __name__ == '__main__':
    args = sys.argv[1:]
    if args[:1] == ['--stats']:
        stats(args[1:])
    elif args[:1] == ['--workflow']:
        phases = {}
        for meta in glob.glob(os.path.join(args[1], '*.meta.json')):
            p = json.load(open(meta)).get('workflowPhase', '?')
            t = usage(meta.replace('.meta.json', '.jsonl'))
            acc = phases.setdefault(p, dict.fromkeys(('fresh', 'cache_write', 'cache_read', 'out', 'in'), 0))
            for k in acc:
                acc[k] += t[k]
        total = dict.fromkeys(next(iter(phases.values()), {}), 0)
        for p, t in phases.items():
            show(p, t)
            for k in t:
                total[k] += t[k]
        show('TOTAL', total)
    else:
        for path in args:
            show(os.path.basename(path), usage(path))
