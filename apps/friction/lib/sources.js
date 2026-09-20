// Where the complaints come from.
//
// Two sources, deliberately:
//
//   Hacker News, through the Algolia search API. Free, no key, no licence,
//   explicitly public. This is the source that carries no platform risk.
//
//   Reddit, through the OFFICIAL OAuth API. The unauthenticated .json
//   endpoints work from a laptop and return 403 from Cloud Run - Reddit
//   blocks datacenter ranges - so the anonymous path is not an option for a
//   scheduled job at all. The free read-only app registration is, and it is
//   also the licensed path: note that GummySearch, the leader in this exact
//   category, shut down on 2025-11-30 for want of a Reddit COMMERCIAL
//   licence. Personal research on a free registration is a different thing
//   from reselling access. If this app is ever sold to anyone, Reddit must be
//   licensed properly or dropped - so it stays isolated behind its own
//   credentials and every item records which source it came from.

const HN_API = 'https://hn.algolia.com/api/v1/search_by_date';
const REDDIT = 'https://www.reddit.com';
const SE_API = 'https://api.stackexchange.com/2.3/search/excerpts';
const GH_API = 'https://api.github.com/search/issues';

// Which sources may appear in anything shown to someone other than the
// account owner. This is not a style preference, it is the difference between
// a product and a lawsuit:
//
//   reddit      Commercial use needs explicit written approval and an
//               enterprise agreement - reported floor around $12,000/month,
//               2-4 week manual review, no self-serve tier. Reading it on a
//               free registration for your own research is fine. Charging
//               anyone for what it produced is not.
//   twitter/x   No longer has a $200 Basic tier; new developers get
//               pay-per-use at ~$0.005 per post read. Affordable at low
//               volume, so it is a cost decision rather than a blocker - but
//               it needs a paid key before a line of code is worth writing.
//   hackernews  Public API, no key, no licence.
//   stackex     Free API. Content is CC BY-SA: attribution and a link back
//               are REQUIRED wherever an excerpt is displayed.
//   github      Free API, generous under a token.
//
// Anything false here must never reach a public or paid surface.
const SOURCE_META = {
  hackernews: { commercialSafe: true, attribution: null },
  stackex: { commercialSafe: true, attribution: 'CC BY-SA, Stack Exchange' },
  github: { commercialSafe: true, attribution: null },
  reddit: { commercialSafe: false, attribution: null },
};

function commercialSafe(source) {
  return Boolean((SOURCE_META[source] || {}).commercialSafe);
}
const UA = 'friction/1.0 (personal research tool; contact via strongtechnicalconsulting.com)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Phrases people actually type when a tool they need does not exist. Browsing
// a subreddit's front page returns mostly noise; these return intent.
// Kept deliberately short. Each phrase is one rate-limited request per
// subreddit, so the list is a direct multiplier on how long a scan takes;
// these six carry the most intent per request.
const INTENT_PHRASES = [
  'is there a tool',
  'anyone know of software',
  'I wish there was',
  'why is there no',
  'still doing this manually',
  'there has to be a better way',
];

// Markets, not topics. Each one is a place where Erik could plausibly reach a
// buyer, plus the broad builder communities for general signal. Editable from
// the app - this is only the starting set.
// Bump SEED_VERSION whenever the machine-tuned fields below change. A lens is
// written to Firestore on first sight, and from then on the saved copy wins -
// which is right for what Erik edits, and wrong for a bug shipped in a query.
// Without this, fixing a query in code changes nothing that already ran.
const SEED_VERSION = 3;

// `hn` is a LIST because Algolia ANDs every word in a query and has no OR
// operator - one string of alternatives matches nothing, which is exactly how
// the first live run returned zero results with no error to explain it.
const DEFAULT_LENSES = [
  { id: 'lending-ops', label: 'Lending & servicing ops', enabled: true,
    subs: ['fintech', 'Banking', 'creditunions', 'Mortgages'],
    hn: ['loan servicing', 'mortgage', 'collections', 'underwriting'],
    se: [{ site: 'money', q: 'loan servicing' }, { site: 'money', q: 'mortgage payment' }],
    gh: ['loan origination', 'payment reconciliation'] },
  { id: 'risk-fraud', label: 'Risk, fraud & compliance', enabled: true,
    subs: ['cybersecurity', 'GRC', 'AskNetsec', 'compliance'],
    hn: ['fraud detection', 'KYC', 'compliance', 'audit'],
    se: [{ site: 'security', q: 'fraud detection' }, { site: 'security', q: 'compliance evidence' }],
    gh: ['KYC verification', 'audit log compliance'] },
  { id: 'it-ops', label: 'IT & MSP operations', enabled: true,
    subs: ['sysadmin', 'msp', 'ITManagers', 'devops'],
    hn: ['saas sprawl', 'offboarding', 'shadow IT', 'sysadmin'],
    se: [{ site: 'serverfault', q: 'user offboarding' }, { site: 'serverfault', q: 'license audit' }],
    gh: ['offboarding automation', 'SaaS license tracking'] },
  { id: 'back-office', label: 'Accounting & back office', enabled: true,
    subs: ['accounting', 'Bookkeeping', 'smallbusiness', 'taxpros'],
    hn: ['bookkeeping', 'reconciliation', 'invoicing', 'payroll'],
    se: [{ site: 'money', q: 'bookkeeping' }, { site: 'money', q: 'invoice tracking' }],
    gh: ['bank reconciliation', 'invoice parsing'] },
  { id: 'data-eng', label: 'Data & analytics', enabled: true,
    subs: ['dataengineering', 'analytics', 'BusinessIntelligence'],
    hn: ['data pipeline', 'data quality', 'reverse ETL', 'dashboards'],
    se: [{ site: 'dba', q: 'data quality' }, { site: 'stackoverflow', q: 'pipeline failure silent' }],
    gh: ['data quality check', 'pipeline silent failure'] },
  { id: 'builders', label: 'Founders & builders', enabled: true,
    subs: ['SaaS', 'startups', 'Entrepreneur', 'indiehackers'],
    hn: ['ask hn tool', 'is there a tool', 'i wish there was'],
    se: [{ site: 'softwareengineering', q: 'is there a tool' }],
    gh: ['feature request workflow'] },
];

function clean(s, max = 4000) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

async function getJson(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Hacker News stories and comments matching one query, newest first. */
async function fromHN(query, sinceUnix, hitsPerPage = 40) {
  const url = `${HN_API}?query=${encodeURIComponent(query)}`
    + `&tags=(story,comment)&numericFilters=created_at_i>${sinceUnix}&hitsPerPage=${hitsPerPage}`;
  const body = await getJson(url);
  return (body.hits || []).map((h) => ({
    id: `hn:${h.objectID}`,
    source: 'hackernews',
    channel: 'news.ycombinator.com',
    title: clean(h.title || h.story_title || ''),
    text: clean(h.comment_text || h.story_text || ''),
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    permalink: `https://news.ycombinator.com/item?id=${h.objectID}`,
    votes: h.points || 0,
    comments: h.num_comments || 0,
    author: h.author || '',
    createdAt: h.created_at || null,
  })).filter((i) => (i.title + i.text).length > 40);
}

// Reddit's read-only OAuth token, cached until shortly before it expires.
let redditToken = { value: null, expiresAt: 0 };

function redditConfigured() {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

async function redditAuth() {
  if (redditToken.value && Date.now() < redditToken.expiresAt) return redditToken.value;
  const basic = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`reddit auth HTTP ${res.status}`);
  const body = await res.json();
  redditToken = {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(60, (body.expires_in || 3600) - 120) * 1000,
  };
  return redditToken.value;
}

/** One subreddit, searched for one phrase, restricted to that sub. */
async function fromReddit(sub, phrase, window = 'month', limit = 25) {
  const token = await redditAuth();
  const url = `https://oauth.reddit.com/r/${encodeURIComponent(sub)}/search`
    + `?q=${encodeURIComponent('"' + phrase + '"')}&restrict_sr=1&sort=new&t=${window}&limit=${limit}&raw_json=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const children = (body && body.data && body.data.children) || [];
  return children.map((c) => c.data).filter(Boolean).map((d) => ({
    id: `rd:${d.id}`,
    source: 'reddit',
    channel: `r/${d.subreddit}`,
    title: clean(d.title || ''),
    text: clean(d.selftext || ''),
    url: d.url_overridden_by_dest || `${REDDIT}${d.permalink}`,
    permalink: `${REDDIT}${d.permalink}`,
    votes: d.ups || 0,
    comments: d.num_comments || 0,
    author: d.author || '',
    createdAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
  })).filter((i) => (i.title + i.text).length > 40);
}

/** Stack Exchange excerpts. Free, no key needed at this volume, and usable
 *  commercially - but the content is CC BY-SA, so anywhere an excerpt is
 *  shown must carry attribution and a link back. SOURCE_META records that;
 *  do not display one of these quotes without it. */
async function fromStackExchange(query, site, sinceUnix, pagesize = 25) {
  const url = `${SE_API}?order=desc&sort=creation&q=${encodeURIComponent(query)}`
    + `&site=${encodeURIComponent(site)}&pagesize=${pagesize}&fromdate=${sinceUnix}`;
  const body = await getJson(url);
  return (body.items || []).map((it) => ({
    id: `se:${site}:${it.question_id}`,
    source: 'stackex',
    channel: `${site}.stackexchange`,
    title: clean(it.title || ''),
    text: clean((it.excerpt || '') + ' ' + (it.body || '')),
    url: `https://${site === 'stackoverflow' ? 'stackoverflow.com' : site + '.stackexchange.com'}/q/${it.question_id}`,
    permalink: `https://${site === 'stackoverflow' ? 'stackoverflow.com' : site + '.stackexchange.com'}/q/${it.question_id}`,
    votes: it.score || 0,
    comments: it.answer_count || 0,
    author: (it.owner && it.owner.display_name) || '',
    createdAt: it.creation_date ? new Date(it.creation_date * 1000).toISOString() : null,
  })).filter((i) => (i.title + i.text).length > 40);
}

/** GitHub issues. Where people describe a tool's shortcoming in the tool's
 *  own tracker, which is about as close to a stated requirement as this gets.
 *  Unauthenticated search is 10 requests/minute, enough at this cadence;
 *  GITHUB_TOKEN raises it if one is ever set. */
async function fromGitHub(query, sinceIso, perPage = 25) {
  const q = `${query} in:body state:open created:>${sinceIso.slice(0, 10)}`;
  const url = `${GH_API}?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=${perPage}`;
  const headers = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return (body.items || []).map((it) => ({
    id: `gh:${it.id}`,
    source: 'github',
    channel: (it.repository_url || '').split('/').slice(-2).join('/') || 'github',
    title: clean(it.title || ''),
    text: clean(it.body || ''),
    url: it.html_url,
    permalink: it.html_url,
    votes: (it.reactions && it.reactions.total_count) || 0,
    comments: it.comments || 0,
    author: (it.user && it.user.login) || '',
    createdAt: it.created_at || null,
  })).filter((i) => (i.title + i.text).length > 40);
}

/** 24 copies of "HTTP 403" is not 24 pieces of information. */
function collapse(errors) {
  const byKey = new Map();
  for (const e of errors) {
    const key = `${e.source}|${e.message}`;
    const hit = byKey.get(key);
    if (hit) { hit.count++; if (e.channel && hit.channels.indexOf(e.channel) < 0) hit.channels.push(e.channel); }
    else byKey.set(key, { source: e.source, lens: e.lens, message: e.message, count: 1, channels: e.channel ? [e.channel] : [] });
  }
  return [...byKey.values()].map((e) => ({
    source: e.source, lens: e.lens, count: e.count,
    channel: e.channels.slice(0, 4).join(', ') + (e.channels.length > 4 ? ` +${e.channels.length - 4}` : ''),
    message: e.count > 1 ? `${e.message} (x${e.count})` : e.message,
  }));
}

/** Everything one lens can see right now, deduped by item id.
 *  A failing source degrades the run instead of ending it: partial evidence
 *  still beats a scan that produced nothing because one host was slow. */
async function harvest(lens, { sinceDays = 14, redditEnabled = true, phrases = INTENT_PHRASES } = {}) {
  const sinceUnix = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  const byId = new Map();
  const errors = [];

  const queries = Array.isArray(lens.hn) ? lens.hn : (lens.hn ? [lens.hn] : []);
  const probes = [];
  for (const q of queries) {
    try {
      const hits = await fromHN(q, sinceUnix);
      probes.push({ source: 'hn', q, hits: hits.length });
      for (const item of hits) byId.set(item.id, item);
    } catch (err) {
      probes.push({ source: 'hn', q, hits: -1, error: err.message });
      errors.push({ source: 'hackernews', lens: lens.id, channel: q, message: err.message });
    }
  }

  // Shape note: these are maps, not two-element arrays. Firestore rejects an
  // array whose elements are arrays, and a lens is written to Firestore.
  for (const { site, q } of (lens.se || [])) {
    try {
      const hits = await fromStackExchange(q, site, sinceUnix);
      probes.push({ source: 'stackex', q: `${site}: ${q}`, hits: hits.length });
      for (const item of hits) byId.set(item.id, item);
    } catch (err) {
      probes.push({ source: 'stackex', q: `${site}: ${q}`, hits: -1, error: err.message });
      errors.push({ source: 'stackex', lens: lens.id, channel: site, message: err.message });
    }
    await sleep(400);
  }

  const sinceIso = new Date(sinceUnix * 1000).toISOString();
  for (const q of (lens.gh || [])) {
    try {
      const hits = await fromGitHub(q, sinceIso);
      probes.push({ source: 'github', q, hits: hits.length });
      for (const item of hits) byId.set(item.id, item);
    } catch (err) {
      probes.push({ source: 'github', q, hits: -1, error: err.message });
      errors.push({ source: 'github', lens: lens.id, channel: q, message: err.message });
    }
    await sleep(6500); // unauthenticated search is 10/minute
  }

  if (redditEnabled && !redditConfigured()) {
    errors.push({
      source: 'reddit', lens: lens.id,
      message: 'skipped: no REDDIT_CLIENT_ID/SECRET set. Reddit returns 403 to datacenter IPs without OAuth.',
    });
  } else if (redditEnabled) {
    let redditHits = 0;
    for (const sub of lens.subs || []) {
      for (const phrase of phrases) {
        try {
          const hits = await fromReddit(sub, phrase);
          redditHits += hits.length;
          for (const item of hits) byId.set(item.id, item);
        } catch (err) {
          redditHits = -1;
          errors.push({ source: 'reddit', lens: lens.id, channel: `r/${sub}`, message: err.message });
        }
        await sleep(1100); // Free tier is 100 requests/minute. Stay well inside it.
      }
    }
    probes.push({ source: 'reddit', q: `${(lens.subs || []).length} subs x ${phrases.length} phrases`, hits: redditHits });
  }

  return { items: [...byId.values()], errors: collapse(errors), probes };
}

module.exports = {
  SEED_VERSION, DEFAULT_LENSES, INTENT_PHRASES, SOURCE_META, commercialSafe,
  harvest, fromHN, fromReddit, fromStackExchange, fromGitHub, redditConfigured, collapse,
};
