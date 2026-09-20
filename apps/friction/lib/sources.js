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
// `hn` is a LIST because Algolia ANDs every word in a query and has no OR
// operator - one string of alternatives matches nothing, which is exactly how
// the first live run returned zero results with no error to explain it.
const DEFAULT_LENSES = [
  { id: 'lending-ops', label: 'Lending & servicing ops', enabled: true,
    subs: ['fintech', 'Banking', 'creditunions', 'Mortgages'],
    hn: ['loan servicing', 'mortgage software', 'debt collections software', 'underwriting workflow'] },
  { id: 'risk-fraud', label: 'Risk, fraud & compliance', enabled: true,
    subs: ['cybersecurity', 'GRC', 'AskNetsec', 'compliance'],
    hn: ['fraud detection', 'KYC onboarding', 'compliance workflow', 'audit evidence'] },
  { id: 'it-ops', label: 'IT & MSP operations', enabled: true,
    subs: ['sysadmin', 'msp', 'ITManagers', 'devops'],
    hn: ['saas sprawl', 'employee offboarding', 'shadow IT', 'license management'] },
  { id: 'back-office', label: 'Accounting & back office', enabled: true,
    subs: ['accounting', 'Bookkeeping', 'smallbusiness', 'taxpros'],
    hn: ['bookkeeping', 'bank reconciliation', 'invoicing', 'payroll software'] },
  { id: 'data-eng', label: 'Data & analytics', enabled: true,
    subs: ['dataengineering', 'analytics', 'BusinessIntelligence'],
    hn: ['data pipeline broke', 'data quality', 'reverse ETL', 'dashboard nobody uses'] },
  { id: 'builders', label: 'Founders & builders', enabled: true,
    subs: ['SaaS', 'startups', 'Entrepreneur', 'indiehackers'],
    hn: ['ask hn tool', 'is there a tool', 'i wish there was'] },
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
  for (const q of queries) {
    try {
      for (const item of await fromHN(q, sinceUnix)) byId.set(item.id, item);
    } catch (err) {
      errors.push({ source: 'hackernews', lens: lens.id, channel: q, message: err.message });
    }
  }

  if (redditEnabled && !redditConfigured()) {
    errors.push({
      source: 'reddit', lens: lens.id,
      message: 'skipped: no REDDIT_CLIENT_ID/SECRET set. Reddit returns 403 to datacenter IPs without OAuth.',
    });
  } else if (redditEnabled) {
    for (const sub of lens.subs || []) {
      for (const phrase of phrases) {
        try {
          for (const item of await fromReddit(sub, phrase)) byId.set(item.id, item);
        } catch (err) {
          errors.push({ source: 'reddit', lens: lens.id, channel: `r/${sub}`, message: err.message });
        }
        await sleep(1100); // Free tier is 100 requests/minute. Stay well inside it.
      }
    }
  }

  return { items: [...byId.values()], errors: collapse(errors) };
}

module.exports = { DEFAULT_LENSES, INTENT_PHRASES, harvest, fromHN, fromReddit, redditConfigured, collapse };
