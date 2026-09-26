# Tokens per app

What it cost to build each lab app, counted from the builder agents'
transcripts with `scripts/token-ledger.py`. "In" is everything the model read
(fresh input, cache writes and cache reads); most of it is cache reads, the
agent re-reading its own work each step, which cost about a tenth of fresh
input. Not counted: the main session's own review and shipping time per app
(one long conversation, not separable by app), and visitors' AI use, which is
in the `identity` database's `usage` collection by `app`.

The daily run appends its drop here, and the Friday LinkedIn draft uses the
week's rows. The same numbers, plus agents and agent time, live in
`build-stats.json`, which the lab page draws ("How it's built" and a line on
each card); `token-ledger.py --stats` writes both from the same transcripts
(see CLAUDE.md, "Build stats"). Keep the two in step.

Agent time is each agent's active span (its transcript's last timestamp minus
its first), summed over agents. For a workflow the agents overlap, so start to
finish is shorter than agent time.

## Week 1 (2026-09-24 to 2026-09-25)

| App | Built by | In | of which cached | Out | Agents | Agent time | Exact? |
|---|---|---|---|---|---|---|---|
| Spar | earlier daily session, with the lab itself | ~25–35M | — | ~200K | 1 | ~45 min | estimate (transcript not in this session) |
| Snapquote | earlier daily session | ~25–35M | — | ~200K | 1 | ~45 min | estimate |
| Chaser | one builder agent | 31.2M | 30.3M | 197K | 1 | 48 min | exact |
| Rave | one builder agent | 24.4M | 23.9M | 199K | 1 | 36 min | exact |
| Pop Quiz | one builder agent | 19.6M | 18.9M | 203K | 1 | 33 min | exact |
| Glowup | one builder agent | 31.0M | 30.5M | 221K | 1 | 44 min | exact |
| Booth | one builder agent | 24.9M | 24.4M | 198K | 1 | 34 min | exact |
| Receipt | workflow: 5 pitches, 3 judges, builder, 4 reviewers, 111 skeptic checks, fixer | 202.1M | 192.0M | 936K | 130 | 3 h 21 m (2 h 34 m start to finish) | exact |

Receipt by stage: ideas and judging 2.7M in / 59K out · build 56.5M / 328K ·
review 66.9M / 271K · skeptic checks 35.7M / 129K · fixes 40.3M / 149K. The
idea was about 1% of the tokens; making it good was the rest. Its review found
32 confirmed problems in the first version (31 fixed).

Week total: about 393M in (96% cached, where the split is known) and 2.4M
out, from 137 agents over 8 h 5 m of agent time, with Spar and Snapquote at
their midpoints (30M in, 200K out, 45 min each). Receipt's cached figure was
first written here as 194.0M; the ledger reads 192.0M, corrected 2026-09-26.

Visitors' AI use in the lab this week: 4 calls (Spar 3, Snapquote 1), about
7K in / 2K out, $0.04.

Not an app: the LinkedIn API research workflow, 64.1M in / 248K out.

## Week 2 (2026-09-26 to 2026-10-02)

| App | Built by | In | of which cached | Out | Agents | Agent time | Exact? |
|---|---|---|---|---|---|---|---|
| Tally | one builder agent | 33.1M | 32.6M | ~210K | 1 | 36 min | in exact; out estimated |

Tally's transcript records only the start of each streamed reply's output
(about 5K in total), a logging change since week 1's builds, so its output is
estimated from comparable single-agent builds (197K–221K). **If a future
transcript's output comes out under ~20K for a whole build, treat it the same
way**: keep the exact input, estimate the output, and label it.

Visitors' AI use in the lab on 2026-09-26: none.
