// Company career boards: Greenhouse, Lever and Ashby.
//
// All three publish a company's open roles through a documented, public,
// unauthenticated JSON API meant for exactly this - embedding a careers page
// anywhere. That is the whole of what Next Move reads for postings. It never
// scrapes LinkedIn, Indeed, Glassdoor or any other aggregator: their terms
// forbid it, and a posting is better read from the company's own board.
//
//   resolve('https://job-boards.greenhouse.io/acme')  -> {provider, token, ...}
//   resolve('Acme')                                    -> probes the three APIs
//   fetchBoard(http, board)                            -> normalised postings
//
// A posting is normalised to the BigQuery `postings` row shape (snake_case),
// so what the job loads is exactly what this returns.

const crypto = require('crypto');
const { htmlToText, clean, httpsUrl, slug } = require('./text');
const { normTitle } = require('./titles');
const pay = require('./pay');

const PROVIDERS = ['greenhouse', 'lever', 'ashby'];
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const DESC_MAX = 20000;

const sha = (s, n = 32) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);

/** The stable key a company is filed under, everywhere (Firestore and BigQuery). */
function companyKeyFor(provider, token) {
  return provider ? `${provider}:${String(token).toLowerCase()}` : `name:${slug(token) || 'unknown'}`;
}
const KEY_RE = /^(greenhouse|lever|ashby|name):[a-z0-9._-]{1,80}$/;

/* ------------------------------------------------------------------ *
 * Resolving what a person typed
 * ------------------------------------------------------------------ */

/** A careers URL -> {provider, token, eu?} or null. */
function parseCareersUrl(input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  const ok = (t) => (t && TOKEN_RE.test(t) ? t : null);
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host === 'boards.eu.greenhouse.io' || host === 'job-boards.eu.greenhouse.io') {
    if (seg[0] === 'embed') { const t = ok(u.searchParams.get('for')); return t ? { provider: 'greenhouse', token: t } : null; }
    const t = ok(seg[0]);
    return t ? { provider: 'greenhouse', token: t } : null;
  }
  if (host === 'boards-api.greenhouse.io' && seg[0] === 'v1' && seg[1] === 'boards') { const t = ok(seg[2]); return t ? { provider: 'greenhouse', token: t } : null; }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') { const t = ok(seg[0]); return t ? { provider: 'lever', token: t, eu: host.includes('.eu.') } : null; }
  if (host === 'api.lever.co' && seg[0] === 'v0' && seg[1] === 'postings') { const t = ok(seg[2]); return t ? { provider: 'lever', token: t } : null; }
  if (host === 'jobs.ashbyhq.com') { const t = ok(seg[0]); return t ? { provider: 'ashby', token: decodeURIComponent(t) } : null; }
  if (host === 'api.ashbyhq.com' && seg[0] === 'posting-api') { const t = ok(seg[2]); return t ? { provider: 'ashby', token: t } : null; }
  return null;
}

/** Slugs a company's board is likely to live under: "Acme Corp" -> acmecorp, acme-corp, acme. */
function slugCandidates(name) {
  const base = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, 'and').replace(/\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|gmbh|sa|ag|the|group|holdings|technologies|technology|labs|hq)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  if (!base) return [];
  const parts = base.split(' ');
  const out = [parts.join(''), parts.join('-'), parts[0]];
  // The full name with the corporate words left in, too ("Acme Labs" boards
  // are sometimes literally "acmelabs").
  const full = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (full) out.push(full);
  return [...new Set(out)].filter((t) => TOKEN_RE.test(t) && t.length >= 2).slice(0, 4);
}

function apiUrl(provider, token, opts = {}) {
  const t = encodeURIComponent(token);
  if (provider === 'greenhouse') return opts.meta ? `https://boards-api.greenhouse.io/v1/boards/${t}` : `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`;
  if (provider === 'lever') return `https://api${opts.eu ? '.eu' : ''}.lever.co/v0/postings/${t}?mode=json${opts.probe ? '&limit=1' : ''}`;
  if (provider === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=${opts.probe ? 'false' : 'true'}`;
  throw new Error(`unknown provider ${provider}`);
}

/** Does this provider have a board under this token? -> {name} or null. */
async function probe(http, provider, token, opts = {}) {
  if (!TOKEN_RE.test(token)) return null;
  try {
    if (provider === 'greenhouse') {
      const meta = await http.json(apiUrl('greenhouse', token, { meta: true }), { timeoutMs: 8000, retries: 0 });
      return meta && typeof meta === 'object' && typeof meta.name === 'string' ? { name: clean(meta.name, 120) || token } : null;
    }
    if (provider === 'lever') {
      const list = await http.json(apiUrl('lever', token, { probe: true, eu: opts.eu }), { timeoutMs: 8000, retries: 0, nullOn: [400] });
      return Array.isArray(list) ? { name: null } : null;
    }
    if (provider === 'ashby') {
      const b = await http.json(apiUrl('ashby', token, { probe: true }), { timeoutMs: 8000, retries: 0, nullOn: [400] });
      return b && Array.isArray(b.jobs) ? { name: null } : null;
    }
  } catch (e) {
    return null;
  }
  return null;
}

function titleCase(t) {
  return String(t).replace(/[-_.]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();
}

/**
 * What someone typed (a careers URL or a company name) -> a board, or a
 * name-only company when no public board answers.
 * @returns {companyKey, name, provider|null, token|null, eu?, found: boolean}
 */
async function resolve(http, input, opts = {}) {
  const raw = clean(input, 300);
  if (!raw) return null;
  const looksUrl = /^https?:\/\//i.test(raw) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(raw);
  if (looksUrl) {
    const parsed = parseCareersUrl(raw);
    if (parsed) {
      const p = await probe(http, parsed.provider, parsed.token, parsed);
      if (p) {
        const name = clean(opts.name, 120) || p.name || titleCase(parsed.token);
        return { companyKey: companyKeyFor(parsed.provider, parsed.token), name, provider: parsed.provider, token: parsed.token, eu: Boolean(parsed.eu), found: true };
      }
      return { companyKey: companyKeyFor(null, parsed.token), name: clean(opts.name, 120) || titleCase(parsed.token), provider: null, token: null, found: false };
    }
    // An unknown careers site: try the company's own domain name as a slug.
    let host = '';
    try { host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^(www|careers|jobs)\./, ''); } catch (e) { return null; }
    return resolve(http, host.split('.')[0], { name: opts.name || titleCase(host.split('.')[0]) });
  }
  for (const token of slugCandidates(raw)) {
    for (const provider of PROVIDERS) {
      const p = await probe(http, provider, token);
      if (p) return { companyKey: companyKeyFor(provider, token), name: clean(opts.name, 120) || p.name || raw, provider, token, eu: false, found: true };
    }
  }
  return { companyKey: companyKeyFor(null, raw), name: clean(opts.name, 120) || raw, provider: null, token: null, found: false };
}

/* ------------------------------------------------------------------ *
 * Locations
 * ------------------------------------------------------------------ */

const STATES = { AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', PR: 'puerto rico' };
const BY_NAME = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v, k]));
// Cities that are their own answer when a board writes only the city.
const CITY_STATE = { 'new york city': 'NY', nyc: 'NY', 'san francisco': 'CA', 'los angeles': 'CA', seattle: 'WA', boston: 'MA', chicago: 'IL', atlanta: 'GA', austin: 'TX', denver: 'CO', 'washington dc': 'DC', 'washington, d.c.': 'DC', 'san jose': 'CA', 'palo alto': 'CA', 'mountain view': 'CA', 'menlo park': 'CA', miami: 'FL', dallas: 'TX', houston: 'TX', philadelphia: 'PA', pittsburgh: 'PA', portland: 'OR', 'salt lake city': 'UT', minneapolis: 'MN', nashville: 'TN', raleigh: 'NC', charlotte: 'NC', phoenix: 'AZ', 'san diego': 'CA', detroit: 'MI' };

/** "New York, NY" / "Atlanta, Georgia" / "Remote - US" -> 'NY' / 'GA' / null. */
function stateOf(location) {
  const s = String(location || '');
  const m = s.match(/,\s*([A-Z]{2})\b(?!\w)/);
  if (m && STATES[m[1]]) return m[1];
  const low = s.toLowerCase();
  for (const [name, code] of Object.entries(BY_NAME)) if (new RegExp(`\\b${name}\\b`).test(low)) return code;
  for (const [city, code] of Object.entries(CITY_STATE)) if (low.includes(city)) return code;
  return null;
}
function isRemote(...texts) {
  return texts.some((t) => /\bremote\b|work from home|\bwfh\b|anywhere/i.test(String(t || '')));
}

/* ------------------------------------------------------------------ *
 * Normalising one posting
 * ------------------------------------------------------------------ */

function contentHash(p) {
  return sha([p.title, p.location, p.remote, p.department, p.pay_min, p.pay_max, p.pay_currency, p.pay_period, p.description_text].join('\u0001'));
}

/**
 * The postings-row shape. `now` is the run's clock (ISO), used for
 * first_seen/last_seen on a posting seen for the first time.
 */
function row({ source, board, externalId, title, department, location, remote, url, postedAt, description, payInfo, paySource, companyName }, now) {
  const t = clean(title, 200);
  const n = normTitle(t);
  const desc = description || '';
  let p = payInfo || null;
  let ps = p ? paySource : null;
  if (!p) { p = pay.parsePay(desc); ps = p ? 'posted' : null; }
  const out = {
    posting_id: sha(`${source}|${board.token || board.companyKey}|${externalId}`),
    source,
    company_key: board.companyKey,
    company_name: clean(companyName || board.name, 120),
    title: t,
    title_norm: n.title_norm,
    seniority: n.seniority,
    department: clean(department, 120) || null,
    location: clean(location, 160) || null,
    location_state: stateOf(location),
    remote: Boolean(remote),
    url: httpsUrl(url) || null,
    posted_at: isoOrNull(postedAt),
    first_seen: now,
    last_seen: now,
    closed_at: null,
    pay_min: p ? p.min : null,
    pay_max: p ? p.max : null,
    pay_currency: p ? p.currency : null,
    pay_period: p ? p.period : null,
    pay_min_annual: p ? p.annualMin : null,
    pay_max_annual: p ? p.annualMax : null,
    pay_source: ps,
    description_text: desc.slice(0, DESC_MAX),
  };
  out.content_hash = contentHash(out);
  return out;
}

function isoOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() > 1999 && d.getUTCFullYear() < 2100 ? d.toISOString() : null;
}

function fromGreenhouse(json, board, now) {
  const jobs = json && Array.isArray(json.jobs) ? json.jobs : [];
  return jobs.filter((j) => j && (j.id || j.id === 0) && j.title).map((j) => {
    const loc = (j.location && j.location.name) || (Array.isArray(j.offices) && j.offices[0] && j.offices[0].name) || '';
    return row({
      source: 'greenhouse', board, externalId: String(j.id), title: j.title,
      department: Array.isArray(j.departments) && j.departments[0] ? j.departments[0].name : null,
      location: loc, remote: isRemote(loc, j.title), url: j.absolute_url,
      postedAt: j.first_published || j.updated_at, description: htmlToText(j.content || '', DESC_MAX), companyName: j.company_name,
    }, now);
  });
}

function fromLever(list, board, now) {
  const jobs = Array.isArray(list) ? list : [];
  return jobs.filter((j) => j && j.id && j.text).map((j) => {
    const c = j.categories || {};
    const parts = [j.descriptionPlain || htmlToText(j.description || '')];
    for (const l of Array.isArray(j.lists) ? j.lists : []) parts.push(`${clean(l.text, 200)}\n${htmlToText(l.content || '')}`);
    if (j.additionalPlain || j.additional) parts.push(j.additionalPlain || htmlToText(j.additional));
    const desc = parts.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').slice(0, DESC_MAX);
    const lp = pay.fromLever(j.salaryRange);
    return row({
      source: 'lever', board, externalId: String(j.id), title: j.text,
      department: c.department || c.team || null, location: c.location || '',
      remote: j.workplaceType === 'remote' || isRemote(c.location, j.text), url: j.hostedUrl,
      postedAt: j.createdAt, description: desc, payInfo: lp, paySource: 'lever_salary',
    }, now);
  });
}

function fromAshby(json, board, now) {
  const jobs = json && Array.isArray(json.jobs) ? json.jobs : [];
  return jobs.filter((j) => j && j.id && j.title && j.isListed !== false).map((j) => {
    const desc = (j.descriptionPlain ? String(j.descriptionPlain) : htmlToText(j.descriptionHtml || '')).slice(0, DESC_MAX);
    const ap = pay.fromAshby(j.compensation);
    return row({
      source: 'ashby', board, externalId: String(j.id), title: j.title,
      department: j.department || j.team || null, location: j.location || '',
      remote: j.isRemote === true || j.workplaceType === 'Remote' || isRemote(j.location, j.title), url: j.jobUrl || j.applyUrl,
      postedAt: j.publishedAt || j.updatedAt, description: desc, payInfo: ap, paySource: 'ashby_comp',
    }, now);
  });
}

/** Every open posting on one board, normalised. Throws when the board cannot be read. */
async function fetchBoard(http, board, now = new Date().toISOString()) {
  if (!board || !PROVIDERS.includes(board.provider) || !TOKEN_RE.test(String(board.token || ''))) throw new Error('not a board');
  const url = apiUrl(board.provider, board.token, { eu: board.eu });
  const json = await http.json(url, { timeoutMs: 30000, maxBytes: 60 * 1024 * 1024 });
  if (json === null) throw Object.assign(new Error('board not found'), { status: 404 });
  const rows = board.provider === 'greenhouse' ? fromGreenhouse(json, board, now) : board.provider === 'lever' ? fromLever(json, board, now) : fromAshby(json, board, now);
  // One row per posting id: a board that lists a job twice is one posting.
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.posting_id) ? false : seen.add(r.posting_id)));
}

module.exports = {
  PROVIDERS, TOKEN_RE, KEY_RE, companyKeyFor, parseCareersUrl, slugCandidates, apiUrl, probe, resolve,
  fetchBoard, fromGreenhouse, fromLever, fromAshby, stateOf, isRemote, contentHash, row, sha, isoOrNull,
};
