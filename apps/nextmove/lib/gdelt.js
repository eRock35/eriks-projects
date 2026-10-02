// GDELT DOC 2.0: news about a watched company in the last day, classified
// into event types by keyword rules (no model - a rule is free and says why).
//
// GDELT asks for no more than one request every five seconds; the job's HTTP
// client spaces requests to api.gdeltproject.org accordingly (see jobs).
// A rate-limit answer comes back as plain text, not JSON, and is treated as
// "no news this time", not as an error worth failing a run over.

const crypto = require('crypto');
const { clean, httpsUrl } = require('./text');
const { normName } = require('./sec');

const API = 'https://api.gdeltproject.org/api/v2/doc/doc';

// In order: the first rule that matches wins.
const RULES = [
  ['layoff', /\b(lay(s|ing)? off|laid off|layoffs?|job cuts?|cuts? \d[\d,]* (jobs|roles|positions|staff|employees)|cutting \d[\d,]* (jobs|roles)|workforce reduction|reduction in force|downsiz\w*|furlough\w*|restructur\w*)\b/i],
  ['acquisition', /\b(acquir\w*|acquisition|to buy|buys|bought|merg(e|er|es|ing)|takeover|take over|deal to purchase)\b/i],
  ['funding', /\b(raises? \$?|raised \$?|funding round|series [a-h]\b|seed round|valuation|venture (round|funding)|ipo\b|goes public|files to go public)/i],
  ['exec_change', /\b(ceo|cfo|cto|coo|cmo|chief [a-z]+ officer|president|chair(man|woman)?|executive|founder)\b.*\b(steps? down|resign\w*|depart\w*|exit\w*|ousted|fired|appoint\w*|names?|named|hires?|hired|joins?|succeed\w*|replac\w*|promot\w*)\b|\b(appoints?|names?|hires?)\b.*\b(ceo|cfo|cto|coo|cmo|chief [a-z]+ officer|president)\b/i],
  ['earnings', /\b(earnings|quarterly results|q[1-4] results|revenue (rose|fell|grew|jumped|dropped)|beats? estimates|miss(es)? estimates|guidance|profit (rose|fell|warning))\b/i],
];

function classify(title) {
  const t = String(title || '');
  for (const [type, re] of RULES) if (re.test(t)) return type;
  return 'other';
}

/** The DOC API query for one company: the exact name as a phrase, English sources. */
function queryFor(name) {
  const phrase = clean(name, 80).replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (phrase.length < 3) return null;
  return `"${phrase}" sourcelang:english`;
}

function urlFor(name, timespan = '1d') {
  const q = queryFor(name);
  if (!q) return null;
  return `${API}?query=${encodeURIComponent(q)}&mode=artlist&format=json&maxrecords=50&sort=datedesc&timespan=${encodeURIComponent(timespan)}`;
}

/** "20261001T123000Z" -> ISO, or null. */
function seenDate(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * An artlist response -> company_events rows. Only articles whose headline
 * names the company (every word of its normalised name) are kept: a phrase
 * match in the body alone is mostly noise.
 */
function eventsFrom(json, companyKey, companyName) {
  const arts = json && Array.isArray(json.articles) ? json.articles : [];
  const need = normName(companyName).split(' ').filter((w) => w.length > 1);
  const seen = new Set();
  const out = [];
  for (const a of arts.slice(0, 100)) {
    const headline = clean(a && a.title, 300);
    const url = httpsUrl(a && a.url, { allowHttp: true });
    const at = seenDate(a && a.seendate);
    if (!headline || !url || !at || seen.has(url)) continue;
    const words = ` ${normName(headline)} `;
    if (!need.length || !need.every((w) => words.includes(` ${w} `))) continue;
    seen.add(url);
    out.push({
      event_id: crypto.createHash('sha256').update(`gdelt|${url}`).digest('hex').slice(0, 32),
      company_key: companyKey,
      source: 'gdelt',
      event_type: classify(headline),
      headline,
      url,
      published_at: at,
      sec_form: null,
      sec_items: [],
    });
  }
  return out;
}

async function news(http, companyKey, companyName, timespan = '1d') {
  const url = urlFor(companyName, timespan);
  if (!url) return [];
  const r = await http.request(url, { timeoutMs: 20000 });
  if (r.status !== 200) return [];
  let json;
  try { json = JSON.parse(r.text); } catch (e) { return []; } // "Please limit requests..." is text
  return eventsFrom(json, companyKey, companyName);
}

module.exports = { classify, queryFor, urlFor, eventsFrom, news, seenDate, API };
