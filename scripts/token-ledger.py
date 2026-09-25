#!/usr/bin/env python3
"""Tokens an agent (or a whole workflow) spent building a Challenge Lab app.

Reads Claude Code transcripts (agent-*.jsonl) and sums each assistant
message's usage once (streamed lines repeat the same message id).

  python3 scripts/token-ledger.py <agent.jsonl> [...]          one line per file
  python3 scripts/token-ledger.py --workflow <workflow dir>    grouped by phase

"in" is everything the model read: fresh input + cache writes + cache reads.
Cache reads are the agent re-reading its own conversation each step; they
are most of the total and cost about a tenth of fresh input, so both are shown.
"""
import glob, json, os, sys


def usage(path):
    seen = {}
    for line in open(path):
        try:
            o = json.loads(line)
        except ValueError:
            continue
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
    return t


def show(label, t):
    print(f"{label:<28} in {t['in']/1e6:8.1f}M  (cached {t['cache_read']/1e6:6.1f}M)  out {t['out']/1e3:8.1f}K")


if __name__ == '__main__':
    args = sys.argv[1:]
    if args[:1] == ['--workflow']:
        phases = {}
        for meta in glob.glob(os.path.join(args[1], '*.meta.json')):
            p = json.load(open(meta)).get('workflowPhase', '?')
            t = usage(meta.replace('.meta.json', '.jsonl'))
            acc = phases.setdefault(p, dict.fromkeys(t, 0))
            for k in t:
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
