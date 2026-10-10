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
| Tipout | one builder agent | 32.3M | 31.8M | ~210K | 1 | 37 min | in exact; out estimated |
| Tells | one builder agent | 50.2M | 49.6M | ~300K | 1 | 53 min | in exact; out estimated |
| Covenant | one builder agent | 27.2M | 26.7M | ~180K | 1 | 31 min | in exact; out estimated |
| Hike | one builder agent | 34.4M | 33.9M | ~235K | 1 | 41 min | in exact; out estimated |
| Dibs | one builder agent | 33.9M | 33.4M | ~225K | 1 | 39 min | in exact; out estimated |
| Leash | one builder agent | 27.8M | 27.1M | ~220K | 1 | 38 min | in exact; out estimated |
| Drip | one builder agent | 37.0M | 36.2M | ~265K | 1 | 47 min | in exact; out estimated |
| Boxed | one builder agent | 38.1M | 37.2M | ~230K | 1 | 41 min | in exact; out estimated |
| Inside Joke | one builder agent | 40.9M | 40.1M | ~280K | 1 | 50 min | in exact; out estimated |
| Flight | one builder agent | 31.4M | 30.6M | ~215K | 1 | 38 min | in exact; out estimated |

Tally's transcript records only the start of each streamed reply's output
(about 5K in total), a logging change since week 1's builds, so its output is
estimated from comparable single-agent builds (197K–221K). **If a future
transcript's output comes out under ~20K for a whole build, treat it the same
way**: keep the exact input, estimate the output, and label it.

Visitors' AI use in the lab on 2026-09-26: none.

Tipout's transcript under-reports output the same way (about 4K for the whole
build), so its output is estimated like Tally's.

Visitors' AI use in the lab on 2026-09-27 (up to the drop, 07:00 UTC): none.

Tells (an extra drop on 2026-09-27, asked for by Erik) is a larger build than
the daily drops (web app, Chrome/Safari-ready extension, bookmarklet,
Shortcut). Its transcript under-reports output the same way (~2K), so output
is estimated from Tipout's rate over its longer agent time.

Visitors' AI use in the lab on 2026-09-27 (whole day): Tells, 1 call,
about 1.6K in / 0.9K out, under $0.01.

Covenant's transcript under-reports output the same way (~4K), so output is
estimated from Tipout's rate over its shorter agent time.

Visitors' AI use in the lab on 2026-09-28: none.

Hike's transcript under-reports output the same way (~4K), so output is
estimated from Tipout's rate over its agent time.

Dibs (an extra drop on 2026-09-29, the lab's first for everyday people,
asked for by Erik) under-reports output the same way (~5K), so output is
estimated from Tipout's rate over its agent time.

Visitors' AI use in the lab on 2026-09-29: none.

Leash's transcript under-reports output the same way (~4K), so output is
estimated from Tipout's rate over its agent time.

Visitors' AI use in the lab on 2026-09-30: none.

Drip's transcript under-reports output the same way (~7K), so output is
estimated from Tipout's rate over its agent time.

Visitors' AI use in the lab on 2026-10-01: none.

Boxed's transcript under-reports output the same way (~4K), so output is
estimated from Tipout's rate over its agent time. Its builder also fixed a
date-dependent assertion in Drip's suite that started failing on 2026-10-02.

Inside Joke and Flight were two extra drops on 2026-10-02, asked for by Erik
the same day and built in parallel. Both transcripts under-report output
the same way (~5-7K), so output is estimated from Tipout's rate.

Not an app in the lab: the Next Move build (apps/nextmove, a portfolio app
on Cloud Run and BigQuery), 48.3M in over 50 min of one builder agent.

Visitors' AI use in the lab on 2026-10-02: none.

Not a new app: Flight's Cellar & Swap feature (2026-10-03, asked for by
Erik), 24.8M in over 27 min of one builder agent.

## Week 3 (2026-10-03 to 2026-10-09)

| App | Built by | In | of which cached | Out | Agents | Agent time | Exact? |
|---|---|---|---|---|---|---|---|
| Shadow | one builder agent | 33.4M | 32.7M | ~240K | 1 | 43 min | in exact; out estimated |
| Chorus | one builder agent | 36.0M | 35.5M | ~215K | 1 | 38 min | in exact; out estimated |
| Tieout | one builder agent | 30.2M | 29.4M | ~200K | 1 | 36 min | in exact; out estimated |
| Shelf Life | one builder agent | 25.8M | 25.0M | ~205K | 1 | 37 min | in exact; out estimated |
| Burnrate | one builder agent | 32.8M | 31.9M | ~205K | 1 | 37 min | in exact; out estimated |
| Pickup | one builder agent | 26.5M | 25.1M | ~225K | 1 | 41 min | in exact; out estimated |
| Parity | one builder agent | 32.8M | 31.6M | ~285K | 1 | 51 min | in exact; out estimated |

Shadow's, Chorus's, Tieout's, Shelf Life's, Burnrate's, Pickup's and Parity's
transcripts under-report output the same way (~4K, ~5K, ~6K, ~7K, ~4K, ~2K, ~5K), so output is estimated from Tipout's rate over each one's
agent time.

## Week 4 (2026-10-10 to 2026-10-16)

| App | Built by | In | of which cached | Out | Agents | Agent time | Exact? |
|---|---|---|---|---|---|---|---|
| Sprout | one builder agent | 33.7M | 32.5M | ~235K | 1 | 42 min | in exact; out estimated |

Sprout's transcript under-reports output the same way as Week 3's (~2K), so
output is estimated from Tipout's rate over its agent time.
