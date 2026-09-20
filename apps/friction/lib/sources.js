// Where the complaints come from.
//
// Two sources, deliberately:
//
//   Hacker News, through the Algolia search API. Free, no key, no licence,
//   explicitly public. This is the source that carries no platform risk.
//
//   Reddit, through the public .json endpoints. Higher signal for operational
//   pain than HN - accountants, sysadmins and small business owners describe
//   problems in plain language there. But note why GummySearch, the leader in
//   this exact category, shut down on 2025-11-30: it could not get a Reddit
//   COMMERCIAL API licence. Reading public JSON for one person's own research
//   is a different thing from reselling it. If this app is ever sold to
//   anyone, Reddit has to be licensed or dropped - so it is isolated behind
//   ENABLE_REDDIT and every item records which source it came from.

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
const DEFAULT_LENSES = [
  { id: 'lending-ops', label: 'Lending & servicing ops', enabled: true,
    subs: ['fintech', 'Banking', 'creditunions', 'Mortgages'],
    hn: 'lending OR mortgage OR servicing OR collections workflow' },
  { id: 'risk-fraud', label: 'Risk, fraud & compliance', enabled: true,
    subs: ['cybersecurity', 'GRC', 'AskNetsec', 'compliance'],
    hn: 'fraud detection OR KYC OR compliance workflow' },
  { id: 'it-ops', label: 'IT & MSP operations', enabled: true,
    subs: ['sysadmin', 'msp', 'ITManagers', 'devops'],
    hn: 'SaaS sprawl OR offboarding OR shadow IT' },
  { id: 'back-office', label: 'Accounting & back office', enabled: true,
    subs: ['accounting', 'Bookkeeping', 'smallbusiness', 'taxpros'],
    hn: 'bookkeeping OR reconciliation OR invoicing workflow' },
  { id: 'data-eng', label: 'Data & analytics', enabled: true,
    subs: ['dataengineering', 'analytics', 'BusinessIntelligence'],
    hn: 'data pipeline OR reverse ETL OR data quality complaint' },
  { id: 'builders', label: 'Founders & builders', enabled: true,
    subs: ['SaaS', 'startups', 'Entrepreneur', 'indiehackers'],
    hn: 'show hn problem OR ask hn tool' },
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

/** Hacker News stories and comments matching a query, newest first. */
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

/** One subreddit, searched for one phrase, restricted to that sub. */
async function fromReddit(sub, phrase, window = 'month', limit = 25) {
  const url = `${REDDIT}/r/${encodeURIComponent(sub)}/search.json`
    + `?q=${encodeURIComponent('"' + phrase + '"')}&restrict_sr=1&sort=new&t=${window}&limit=${limit}`;
  const body = await getJson(url);
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

/** Everything one lens can see right now, deduped by item id.
 *  A failing source degrades the run instead of ending it: partial evidence
 *  still beats a scan that produced nothing because one host was slow. */
async function harvest(lens, { sinceDays = 14, redditEnabled = true, phrases = INTENT_PHRASES } = {}) {
  const sinceUnix = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  const byId = new Map();
  const errors = [];

  try {
    for (const item of await fromHN(lens.hn, sinceUnix)) byId.set(item.id, item);
  } catch (err) {
    errors.push({ source: 'hackernews', lens: lens.id, message: err.message });
  }

  if (redditEnabled) {
    for (const sub of lens.subs || []) {
      for (const phrase of phrases) {
        try {
          for (const item of await fromReddit(sub, phrase)) byId.set(item.id, item);
        } catch (err) {
          errors.push({ source: 'reddit', lens: lens.id, channel: `r/${sub}`, message: err.message });
        }
        await sleep(1100); // Reddit's public endpoints are rate limited. Be a good citizen.
      }
    }
  }

  return { items: [...byId.values()], errors };
}

module.exports = { DEFAULT_LENSES, INTENT_PHRASES, harvest, fromHN, fromReddit };
