// Shared by the test suite and the seeded dev server: a fake network for
// every public source, a tiny xlsx writer, and an HTTP client with cookies.
// No real network is ever touched: anything unrouted throws.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIX = path.join(__dirname, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

function response(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers } });
}

/**
 * A fetch that answers only from routes: [[RegExp|string, (url, init) => Response|object|string]].
 * Records every call. Unrouted URLs throw, so a test cannot reach the internet.
 */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers || {}, method: init.method || 'GET' });
    for (const [match, answer] of routes) {
      if (typeof match === 'string' ? u === match : match.test(u)) {
        const out = await answer(u, init);
        if (out instanceof Response) return out;
        if (out === null) return response(404, { error: 'not found' });
        return response(200, out);
      }
    }
    throw new Error(`test network: no route for ${u}`);
  };
  f.calls = calls;
  return f;
}

/** Every public source this app reads, answered from fixtures. */
function sourceRoutes(extra = []) {
  return extra.concat([
    [/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/harborview$/, () => JSON.parse(fixture('greenhouse-board.json'))],
    [/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/harborview\/jobs\?content=true$/, () => JSON.parse(fixture('greenhouse-jobs.json'))],
    [/^https:\/\/api\.lever\.co\/v0\/postings\/northwind\?mode=json(&limit=1)?$/, () => JSON.parse(fixture('lever-postings.json'))],
    [/^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/copperline\?includeCompensation=(true|false)$/, () => JSON.parse(fixture('ashby-board.json'))],
    [/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/[^/]+$/, () => null],
    [/^https:\/\/api\.lever\.co\/v0\/postings\//, () => null],
    [/^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\//, () => null],
    ['https://www.sec.gov/files/company_tickers.json', () => JSON.parse(fixture('sec-tickers.json'))],
    [/^https:\/\/data\.sec\.gov\/submissions\/CIK0001990001\.json$/, () => JSON.parse(fixture('sec-submissions.json'))],
    [/^https:\/\/data\.sec\.gov\/submissions\//, () => ({ cik: '0', name: 'X', filings: { recent: { form: [] } } })],
    [/^https:\/\/api\.gdeltproject\.org\/api\/v2\/doc\/doc\?.*Northwind/, () => JSON.parse(fixture('gdelt-artlist.json'))],
    [/^https:\/\/api\.gdeltproject\.org\//, () => ({ articles: [] })],
  ]);
}

/* ------------------------------------------------------------------ *
 * A minimal .xlsx writer (stored + deflated entries, shared strings)
 * ------------------------------------------------------------------ */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, deflate = true] of files) {
    const data = Buffer.from(content);
    const comp = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

/** rows: arrays of strings/numbers/null. Strings go to the shared table, except every third, inline - both shapes are read. */
function xlsx(rows, { title } = {}) {
  const shared = [];
  const index = new Map();
  const sid = (s) => { if (!index.has(s)) { index.set(s, shared.length); shared.push(s); } return index.get(s); };
  let n = 0;
  const allRows = title ? [[title]].concat(rows) : rows;
  const rowXml = allRows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${colName(ci)}${ri + 1}`;
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    n++;
    if (n % 3 === 0) return `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`;
    return `<c r="${ref}" t="s"><v>${sid(String(v))}</v></c>`;
  }).join('')}</row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData><rowBreaks count="0"/></worksheet>`;
  const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s, i) => (i === 1 ? `<si><r><t>${xmlEsc(s.slice(0, 2))}</t></r><r><t xml:space="preserve">${xmlEsc(s.slice(2))}</t></r><rPh><t>PHONETIC</t></rPh></si>` : `<si><t>${xmlEsc(s)}</t></si>`)).join('')}</sst>`;
  const wb = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId7"/></sheets></workbook>';
  const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/data.xml"/></Relationships>';
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>', false],
    ['xl/workbook.xml', wb],
    ['xl/_rels/workbook.xml.rels', rels],
    ['xl/sharedStrings.xml', sst],
    ['xl/worksheets/data.xml', sheet],
  ]);
}

/** A small, real-shaped LCA disclosure file. */
const LCA_HEADER = ['CASE_NUMBER', 'CASE_STATUS', 'RECEIVED_DATE', 'DECISION_DATE', 'VISA_CLASS', 'JOB_TITLE', 'SOC_CODE', 'SOC_TITLE', 'FULL_TIME_POSITION', 'EMPLOYER_NAME', 'EMPLOYER_POC_EMAIL', 'EMPLOYER_POC_PHONE', 'AGENT_ATTORNEY_EMAIL_ADDRESS', 'WORKSITE_CITY', 'WORKSITE_STATE', 'WAGE_RATE_OF_PAY_FROM', 'WAGE_RATE_OF_PAY_TO', 'WAGE_UNIT_OF_PAY', 'PREVAILING_WAGE', 'PW_UNIT_OF_PAY'];
function lcaRows(count = 30) {
  const rows = [LCA_HEADER];
  const cities = [['ATLANTA', 'GA'], ['NEW YORK', 'NY'], ['SAN FRANCISCO', 'CA'], ['AUSTIN', 'TX']];
  for (let i = 0; i < count; i++) {
    const [city, st] = cities[i % cities.length];
    rows.push([`I-200-26${String(i).padStart(3, '0')}-000001`, 'Certified', 45900, 45910, 'H-1B', i % 2 ? 'DIRECTOR, ANALYTICS' : 'Director of Analytics', '11-3021.00', 'Computer and Information Systems Managers', 'Y', 'EXAMPLE ANALYTICS LLC', 'hr.person@employer.example', '+1 (404) 555-0100', 'lawyer@lawfirm.example', city, st, String(160000 + i * 1000), '', 'Year', 150000, 'Year']);
  }
  rows.push(['I-1', 'Denied', 1, 1, 'H-1B', 'Director of Analytics', '11-3021', 'x', 'Y', 'DENIED CO', 'a@b.example', '', '', 'ATLANTA', 'GA', '999999', '', 'Year', 1, 'Year']);
  rows.push(['I-2', 'Certified - Withdrawn', 1, 1, 'H-1B', 'Director of Analytics', '11-3021', 'x', 'Y', 'WD CO', '', '', '', 'ATLANTA', 'GA', '170000', '', 'Year', 1, 'Year']);
  rows.push(['I-3', 'Certified', 1, 1, 'H-1B', 'Data Analyst', '15-2051', 'x', 'Y', 'HOURLY CO', '', '', '', 'Atlanta', 'GA', '$40.00', '', 'Hour', 1, 'Hour']);
  rows.push(['I-4', 'Certified', 1, 1, 'H-1B', 'Data Analyst', '15-2051', 'x', 'Y', 'BIWEEKLY CO', '', '', '', 'Atlanta', 'GA', '3,000', '', 'Bi-Weekly', 1, 'Bi-Weekly']);
  rows.push(['I-5', 'Certified', 1, 1, 'H-1B', 'Data Analyst', '15-2051', 'x', 'N', 'PARTTIME CO', '', '', '', 'Atlanta', 'GA', '30', '', 'Hour', 1, 'Hour']);
  rows.push(['I-6', 'Certified', 1, 1, 'H-1B', 'Data Analyst', '15-2051', 'x', 'Y', 'TYPO CO', '', '', '', 'Atlanta', 'GA', '85', '', 'Year', 1, 'Year']);
  rows.push(['I-7', 'Certified', 1, 1, 'E-3 Australian', 'Data Analyst', '15-2051', 'x', 'Y', 'E3 CO', '', '', '', 'Atlanta', 'GA', '6,500', '', 'Month', 1, 'Month']);
  return rows;
}

/** A tiny OEWS file (national + state rows, plus rows that must be skipped). */
function oewsRows() {
  const H = ['AREA', 'AREA_TITLE', 'AREA_TYPE', 'PRIM_STATE', 'NAICS', 'NAICS_TITLE', 'I_GROUP', 'OWN_CODE', 'OCC_CODE', 'OCC_TITLE', 'O_GROUP', 'TOT_EMP', 'A_MEAN', 'A_PCT25', 'A_MEDIAN', 'A_PCT75'];
  return [H,
    ['99', 'U.S.', '1', 'US', '000000', 'Cross-industry', 'cross-industry', '1235', '11-3021', 'Computer and Information Systems Managers', 'detailed', '591,000', '182,000', '134,000', '172,000', '214,000'],
    ['99', 'U.S.', '1', 'US', '000000', 'Cross-industry', 'cross-industry', '1235', '11-0000', 'Management Occupations', 'major', '1', '1', '1', '1', '1'],
    ['13', 'Georgia', '2', 'GA', '000000', 'Cross-industry', 'cross-industry', '1235', '11-3021', 'Computer and Information Systems Managers', 'detailed', '18,900', '170,000', '128,000', '161,000', '#'],
    ['12060', 'Atlanta MSA', '4', 'GA', '000000', 'Cross-industry', 'cross-industry', '1235', '11-3021', 'Computer and Information Systems Managers', 'detailed', '9,000', '1', '1', '1', '1'],
    ['13', 'Georgia', '2', 'GA', '000000', 'Cross-industry', 'cross-industry', '1235', '15-2051', 'Data Scientists', 'detailed', '*', '*', '*', '*', '*'],
  ];
}

/* ------------------------------------------------------------------ *
 * HTTP with cookies
 * ------------------------------------------------------------------ */

let ipSeq = 10;
function client(base, ip) {
  const cookies = {};
  const addr = ip || `203.0.113.${ipSeq++}`;
  const call = async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { text }; }
    return { status: res.status, data, text, headers: res.headers };
  };
  call.cookies = cookies;
  return call;
}

/** A profile that matches the fixtures. */
function demoProfile() {
  return {
    background: {
      headline: 'Director of Analytics, healthcare and retail',
      summary: 'Twelve years building analytics teams; led a 14-person team covering forecasting, experimentation and BI.',
      yearsExperience: 12,
      roles: [{ title: 'Director of Analytics', company: 'A health system', years: 4, highlights: 'Built demand forecasting that cut stockouts 18%.' }],
      skills: ['SQL', 'Python', 'Forecasting', 'Experimentation', 'Looker', 'dbt'],
      industries: ['Healthcare', 'Retail'],
      education: ['MS Statistics'],
    },
    targets: { titles: ['Director of Analytics', 'Head of Data'], seniority: 'director', locations: ['Atlanta, GA'], remote: 'remote_ok', compFloor: 185000 },
  };
}

module.exports = { fixture, fakeFetch, sourceRoutes, response, zip, xlsx, lcaRows, oewsRows, client, demoProfile, crc32 };
