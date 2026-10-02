// The daily job: read every watched company's career board, upsert the
// postings into BigQuery, pick up new filings and news, then score each
// person's best new matches.
//
//   1. boards   - the union of everyone's watchlist, stalest first, capped
//                 (NEXTMOVE_MAX_BOARDS_PER_RUN); each fetched politely.
//   2. postings - diffed against what BigQuery holds, loaded into a stage
//                 table and MERGEd (new rows inserted, seen ones' last_seen
//                 moved, gone ones closed). Only boards that loaded can close.
//   3. events   - SEC 8-Ks (when SEC_USER_AGENT is set) and GDELT news.
//   4. scoring  - per eligible person: the prefilter's top N of what is new or
//                 changed at their companies or matches their titles (all of
//                 it, the first time or after they change their profile),
//                 one score_fit call each, charged to them.
//
// Everything is awaited; nothing runs after the summary is written. A board,
// a filing or a person failing is recorded and the run goes on; BigQuery
// failing is a failed run (exit 1).

const crypto = require('crypto');
const boards = require('./boards');
const sec = require('./sec');
const gdelt = require('./gdelt');
const { Q } = require('./queries');
const { P } = require('./bq');
const profileLib = require('./profile');
const { keyFor } = require('./userkey');
const spend = require('./spend');
const { scoreUser } = require('./score');

const DAY = 864e5;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

function runId(now) {
  return `${now.slice(0, 10).replace(/-/g, '')}t${now.slice(11, 16).replace(':', '')}${crypto.randomBytes(3).toString('hex')}`;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** Everyone's profile, and the union of their watchlists. */
async function watched(store) {
  const users = (await store.list('users')).map((d) => ({ uid: d.id, doc: d, profile: profileLib.view(d) }));
  const companies = new Map();
  for (const u of users) {
    for (const w of u.profile.watchlist) {
      const c = companies.get(w.companyKey) || { ...w, watchers: 0 };
      c.watchers++;
      companies.set(w.companyKey, c);
    }
  }
  return { users, companies };
}

async function loadInChunks(bq, table, rows, o = {}, size = 4000) {
  for (let i = 0; i < rows.length; i += size) {
    await bq.load(table, rows.slice(i, i + size), { ...o, write: i === 0 ? o.write : 'append' });
  }
}

async function upsertPostings(bq, fetched, fetchedKeys, now, id) {
  if (!fetchedKeys.length) return { inserted: 0, merged: 0 };
  const stage = `postings_stage_${id}`;
  await bq.createTable(stage, { schemaOf: 'postings', expiresInMs: DAY, plain: true });
  try {
    if (fetched.length) await loadInChunks(bq, stage, fetched, { schemaOf: 'postings', write: 'truncate' });
    const r = await bq.run(Q.mergePostings(stage), { companies: P.strs(fetchedKeys), now: P.ts(now) });
    return { merged: r.affected };
  } finally {
    await bq.dropTable(stage).catch(() => {});
  }
}

async function storeEvents(bq, events) {
  if (!events.length) return 0;
  const unique = [...new Map(events.map((e) => [e.event_id, e])).values()];
  const since = new Date(Math.min(...unique.map((e) => Date.parse(e.published_at))) - DAY).toISOString();
  const have = new Set((await bq.run(Q.EVENT_IDS, { ids: P.strs(unique.map((e) => e.event_id)), since: P.ts(since) })).map((r) => r.event_id));
  const add = unique.filter((e) => !have.has(e.event_id));
  if (add.length) await bq.load('company_events', add);
  return add.length;
}

/**
 * @param o.ctx   lib/context (store, bqClient, identity, identityStore, spendingClient, MODELS)
 * @param o.http  {boards, sec, gdelt} polite clients
 */
async function run(o) {
  const { ctx, http } = o;
  const env = o.env || process.env;
  const now = o.now || new Date().toISOString();
  const id = o.runId || runId(now);
  const store = ctx.store;
  const bq = ctx.bqClient();
  const errors = [];
  const counts = { boards: 0, boardsFailed: 0, postingsSeen: 0, postingsNew: 0, postingsChanged: 0, postingsClosed: 0, events: 0, users: 0, usersScored: 0, fits: 0, fitsFailed: 0, skipped: {}, costUsd: 0 };
  const note = (where, err) => errors.push({ where: String(where).slice(0, 80), error: String((err && err.message) || err).slice(0, 200), status: err && err.status ? err.status : null });

  await bq.ensureTables();
  const { users, companies } = await watched(store);
  counts.users = users.length;

  /* 1. boards */
  const maxBoards = num(env.NEXTMOVE_MAX_BOARDS_PER_RUN, 150);
  const withBoard = [...companies.values()].filter((c) => c.provider && c.token);
  const states = new Map();
  for (const c of withBoard) states.set(c.companyKey, await store.get('boards', c.companyKey).catch(() => null));
  withBoard.sort((a, b) => String((states.get(a.companyKey) || {}).lastFetchedAt || '').localeCompare(String((states.get(b.companyKey) || {}).lastFetchedAt || '')));
  const toFetch = withBoard.slice(0, maxBoards);
  const fetchedBy = new Map();
  await pool(toFetch, 4, async (c) => {
    try {
      fetchedBy.set(c.companyKey, await boards.fetchBoard(http.boards, c, now));
    } catch (err) {
      counts.boardsFailed++;
      note(`board ${c.companyKey}`, err);
      await store.merge('boards', c.companyKey, { lastError: String(err.message || 'failed').slice(0, 120), lastErrorAt: now }).catch(() => {});
    }
  });
  const fetchedKeys = [...fetchedBy.keys()];
  const fetched = [].concat(...fetchedBy.values());
  counts.boards = fetchedKeys.length;
  counts.postingsSeen = fetched.length;

  /* 2. postings: diff, then MERGE */
  const existing = new Map();
  if (fetchedKeys.length) {
    for (const r of await bq.run(Q.EXISTING, { companies: P.strs(fetchedKeys) })) existing.set(r.posting_id, r);
  }
  const delta = [];
  const fetchedIds = new Set(fetched.map((p) => p.posting_id));
  for (const p of fetched) {
    const e = existing.get(p.posting_id);
    if (!e || e.closed_at) { counts.postingsNew++; delta.push(p); } else if (e.content_hash !== p.content_hash) { counts.postingsChanged++; delta.push(p); }
    if (e && !e.closed_at) p.first_seen = new Date(e.first_seen).toISOString(); // for counts below; MERGE keeps the stored one
  }
  for (const [pid, e] of existing) if (!e.closed_at && !fetchedIds.has(pid)) counts.postingsClosed++;
  await upsertPostings(bq, fetched, fetchedKeys, now, id);

  const weekAgo = Date.parse(now) - 7 * DAY;
  for (const [key, rows] of fetchedBy) {
    const newest = rows.slice().sort((a, b) => String(b.first_seen).localeCompare(String(a.first_seen)) || String(b.posted_at || '').localeCompare(String(a.posted_at || ''))).slice(0, 6)
      .map((r) => ({ title: r.title, url: r.url, location: r.location, firstSeen: r.first_seen }));
    await store.merge('boards', key, {
      companyKey: key, name: companies.get(key).name, provider: companies.get(key).provider, token: companies.get(key).token,
      lastFetchedAt: now, openCount: rows.length, newThisWeek: rows.filter((r) => Date.parse(r.first_seen) >= weekAgo).length,
      newest, lastError: null, watchers: companies.get(key).watchers,
    });
  }

  /* 3. events: SEC, then GDELT */
  const events = [];
  let tickers = null;
  try { sec.userAgent(env); } catch (err) { counts.secSkipped = 'no SEC_USER_AGENT'; }
  if (!counts.secSkipped) {
    try { tickers = await sec.loadTickers(http.sec, env); } catch (err) { note('sec tickers', err); }
  }
  const maxSec = num(env.NEXTMOVE_MAX_SEC_PER_RUN, 100);
  const maxNews = num(env.NEXTMOVE_MAX_NEWS_PER_RUN, 40);
  let secDone = 0;
  const all = [...companies.values()];
  const boardDocs = new Map();
  for (const c of all) boardDocs.set(c.companyKey, states.get(c.companyKey) || await store.get('boards', c.companyKey).catch(() => null) || {});
  if (tickers) {
    for (const c of all) {
      if (secDone >= maxSec) break;
      const doc = boardDocs.get(c.companyKey);
      let cik = doc.cik || null;
      if (!cik && !(doc.cikCheckedAt && Date.parse(doc.cikCheckedAt) > Date.parse(now) - 30 * DAY)) {
        const hit = sec.cikFor(tickers, c.name);
        cik = hit ? hit.cik : null;
        await store.merge('boards', c.companyKey, { companyKey: c.companyKey, name: c.name, cik, cikName: hit ? hit.title : null, cikCheckedAt: now }).catch(() => {});
      }
      if (!cik) continue;
      secDone++;
      try {
        const since = doc.secSince || new Date(Date.parse(now) - 30 * DAY).toISOString();
        events.push(...await sec.filings(http.sec, cik, c.companyKey, since, env));
        await store.merge('boards', c.companyKey, { secSince: now }).catch(() => {});
      } catch (err) { note(`sec ${c.companyKey}`, err); }
    }
  }
  const byNews = all.slice().sort((a, b) => String(boardDocs.get(a.companyKey).newsAt || '').localeCompare(String(boardDocs.get(b.companyKey).newsAt || ''))).slice(0, maxNews);
  for (const c of byNews) {
    const last = Date.parse(boardDocs.get(c.companyKey).newsAt || 0) || 0;
    const span = Date.parse(now) - last > 3 * DAY ? '7d' : '1d';
    try {
      events.push(...await gdelt.news(http.gdelt, c.companyKey, c.name, span));
      await store.merge('boards', c.companyKey, { companyKey: c.companyKey, name: c.name, newsAt: now }).catch(() => {});
    } catch (err) { note(`gdelt ${c.companyKey}`, err); }
  }
  try { counts.events = await storeEvents(bq, events); } catch (err) { note('events', err); }

  /* 4. scoring */
  const caps = spend.runCaps(env);
  const websearch = await bq.run(Q.RECENT_WEBSEARCH, { since: P.ts(new Date(Date.parse(now) - 8 * DAY).toISOString()) }).catch((err) => { note('websearch postings', err); return []; });
  const onboarded = users.filter((u) => u.profile.onboarded);
  const keyOf = new Map(onboarded.map((u) => [u.uid, keyFor(u.uid)]));
  const scored = new Map(); // user_key -> Map(posting_id -> hash)
  if (onboarded.length) {
    const rows = await bq.run(Q.SCORED, { keys: P.strs([...keyOf.values()]), since: P.ts(new Date(Date.parse(now) - 60 * DAY).toISOString()) });
    for (const r of rows) { if (!scored.has(r.user_key)) scored.set(r.user_key, new Map()); scored.get(r.user_key).set(r.posting_id, r.content_hash); }
  }
  const allRows = [];
  // A few people at a time: each person's calls are sequential (their own
  // budget is checked between them), and the run's caps are shared - at most
  // NEXTMOVE_SCORE_CONCURRENCY calls past a cap can already be in flight.
  await pool(onboarded, num(env.NEXTMOVE_SCORE_CONCURRENCY, 4), async (u) => {
    const skip = (why) => { counts.skipped[why] = (counts.skipped[why] || 0) + 1; return store.merge('users', u.uid, { lastRun: { at: now, scored: 0, skipped: why } }).catch(() => {}); };
    if (!caps.canSpend()) return skip('run-cap');
    const elig = await spend.eligible(ctx.identity, ctx.identityStore, u.uid, ctx.MODELS);
    if (elig.skip) return skip(elig.skip);
    const changedAt = Math.max(Date.parse(u.doc.profileUpdatedAt || 0) || 0, Date.parse(u.doc.watchlistUpdatedAt || 0) || 0);
    const backfill = !u.doc.lastScoredAt || changedAt > Date.parse(u.doc.lastScoredAt);
    const postings = (backfill ? fetched : delta).concat(websearch);
    try {
      const client = await ctx.spendingClient(elig.account, 'nextmove-score');
      const r = await scoreUser({ client, plan: elig.plan, profile: u.profile, userKey: keyOf.get(u.uid), postings, caps, scored: scored.get(keyOf.get(u.uid)), remainingUsd: elig.remainingUsd, now });
      allRows.push(...r.rows);
      counts.fits += r.scored;
      counts.fitsFailed += r.failed;
      if (r.scored) counts.usersScored++;
      if (r.stopped) counts.skipped[r.stopped] = (counts.skipped[r.stopped] || 0) + 1;
      await store.merge('users', u.uid, { lastScoredAt: r.stopped ? (u.doc.lastScoredAt || null) : now, lastRun: { at: now, scored: r.scored, skipped: r.stopped || null } });
    } catch (err) { note('score user', err); }
    return null;
  });
  counts.costUsd = caps.usd;
  counts.calls = caps.calls;
  if (allRows.length) await loadInChunks(ctx.bqClient(), 'fits', allRows, {});
  return { runId: id, counts, errors };
}

module.exports = { run, runId, watched, upsertPostings, storeEvents, pool, loadInChunks };
