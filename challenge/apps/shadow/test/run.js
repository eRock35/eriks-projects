// Pure rules first, then end to end against the memory store and the fake
// model:
//   SHADOW_MEMORY=1 SHADOW_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /shadow, the way
// the lab mounts it, so the auth cookie, the budget gate, the big-body
// routes, the saved inventories and the staff request links are exercised
// as deployed. Model calls are counted from the identity's usage rows - the
// same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.SHADOW_MEMORY !== '1' || process.env.SHADOW_FAKE_AI !== '1') {
  console.error('run with SHADOW_MEMORY=1 SHADOW_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const C = require('../public/shadow-core');
const S = require('../public/sample');
const O = require('../lib/orgs');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const FIX = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const TODAY = '2026-10-03';

let base;
let ipSeq = 10;
const freshIp = () => `203.0.113.${ipSeq++}`;
function client(ip) {
  const cookies = {};
  const addr = ip || freshIp();
  const call = async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { text }; }
    return { status: res.status, data, text, headers: res.headers, setCookie: set };
  };
  call.cookies = cookies;
  return call;
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const byName = (tools, name) => tools.find((t) => t.name === name);
const tool = (o) => C.cleanTool({ name: 'Tool', ...o });

/* ---------------- pure: money and dates ---------------- */

test('money is read from its digits; dates in every format a bank writes', () => {
  const signed = { '-17.99': -1799, '$1,234.56': 123456, '(12.00)': -1200, '12.00-': -1200, '12,50': 1250, '-1.234,56': -123456, '€ 3': 300, 'USD 12': 1200 };
  for (const [v, want] of Object.entries(signed)) assert.strictEqual(C.signedCents(v), want, v);
  for (const bad of ['free', '', 'twelve', '$', '1e5', null, {}, NaN, '12a.00']) assert.strictEqual(C.signedCents(bad), null, String(bad));
  assert.strictEqual(C.toCents('-5.00'), null, 'a typed figure is never negative');
  assert.strictEqual(C.toCents(0.1 + 0.2), 30);
  assert.deepStrictEqual([C.money(123456), C.money(261591, { whole: true }), C.plain(120000), C.plain(1799)], ['$1,234.56', '$2,616', '1200', '17.99']);
  for (const [v, want] of [['2026-09-12', '2026-09-12'], ['09/12/2026', '2026-09-12'], ['12.09.2026', '2026-09-12'], ['20260912', '2026-09-12'], ['Sep 12, 2026', '2026-09-12'], ['12 Sep 2026', '2026-09-12'], ['2026-09-14 10:22:01', '2026-09-14']]) assert.strictEqual(C.parseDate(v), want, v);
  assert.strictEqual(C.parseDate('2026-02-30'), null);
});

/* ---------------- pure: card statements ---------------- */

const DIALECTS = {
  'chase-business.csv': { n: 14, skipped: { payments: 1, refunds: 1 }, software: ['Notewise', 'Slack', 'Zoom', 'Formly'], not: ['Blue Bottle', 'Staples', 'Amazon'] },
  'amex-business.csv': { n: 10, skipped: { payments: 1 }, software: ['Adobe Creative Cloud', 'Brightdesk', 'Canva'], not: ['Thai Palace'] },
  'capital-one.csv': { n: 5, skipped: { payments: 1 }, software: ['Gusto', 'DocuSign'], not: ['Home Depot'] },
  'bofa-summary.csv': { n: 4, skipped: { transfers: 1, interest: 1, unreadable: 1 }, software: ['QuickBooks', 'Kiosko'], not: [] },
  'euro-semicolon.csv': { n: 4, skipped: { moneyIn: 1 }, software: ['Figma'], not: ['Baeckerei'] },
  'expense-report.csv': { n: 4, skipped: {}, software: ['ChatGPT'], not: ['Hampton'] },
};

test('six card and expense dialects: read, money-in skipped and counted, software found, ordinary spending not', () => {
  for (const [file, want] of Object.entries(DIALECTS)) {
    const p = C.parseStatement(FIX(file));
    assert.ok(!p.error, `${file}: ${p.error}`);
    assert.strictEqual(p.transactions.length, want.n, `${file}: ${p.transactions.map((t) => t.desc).join(' | ')}`);
    assert.deepStrictEqual(p.skipped, { payments: 0, transfers: 0, refunds: 0, interest: 0, moneyIn: 0, unreadable: 0, ...want.skipped }, file);
    const s = C.findSoftware(p.transactions, { today: TODAY });
    assert.deepStrictEqual(s.tools.map((t) => t.name).sort(), want.software.slice().sort(), file);
    for (const n of want.not) assert.ok(!s.tools.some((t) => t.name.includes(n)), `${file}: ${n} is not software`);
  }
});

test('known vendors, cadence and spend a year; generic software is "probably"; trials converted and running', () => {
  const s = C.findSoftware(C.parseStatement(FIX('chase-business.csv')).transactions, { today: TODAY }).tools;
  const slack = byName(s, 'Slack');
  assert.deepStrictEqual([slack.billing, slack.spendCents, slack.probable, slack.cat], ['monthly', 8750 * 12, false, 'chat'], 'a seat added later: the latest bill x 12');
  const zoom = byName(s, 'Zoom');
  assert.deepStrictEqual([zoom.billing, zoom.spendCents, zoom.renewal], ['annual', 14990, '2027-06-30'], 'one big charge with 40+ days after it: probably yearly');
  const nw = byName(s, 'Notewise');
  assert.strictEqual(nw.probable, true, 'not in the table: probably software - check');
  assert.deepStrictEqual(nw.trial, { start: '2026-07-06', converts: '2026-07-20', cents: 100, converted: true, estimated: false });
  const formly = byName(s, 'Formly');
  assert.deepStrictEqual([formly.billing, formly.spendCents, formly.trial.converted, formly.trial.converts], ['trial', 0, false, '2026-10-11'], 'a $1 card check 6 days ago: converts about 14 days after');
  // The descriptor says TRIAL and nothing else does: still a trial.
  const word = C.findSoftware([{ date: '2026-09-30', cents: 0, desc: 'PIXELPOSTER TRIAL' }], { today: TODAY }).tools;
  assert.strictEqual(word[0].trial.converts, '2026-10-14');
  // A weak hint alone, one charge: not software.
  assert.strictEqual(C.findSoftware([{ date: '2026-09-01', cents: 4000, desc: 'MAPLE DATA PRINTING' }], { today: TODAY }).tools.length, 0);
  // A strong hint, one charge: software.
  assert.strictEqual(C.findSoftware([{ date: '2026-09-01', cents: 4000, desc: 'LEDGERLY.IO' }], { today: TODAY }).tools[0].name, 'Ledgerly');
  // A monthly gym or a utility with "online" or "cloud" in the name is not software.
  for (const desc of ['COMCAST BUSINESS CLOUD', 'STARBUCKS APP RELOAD', 'AMAZON PRIME*2K4 AMZN.COM/BILL']) {
    const rows = [0, 1, 2, 3].map((i) => ({ date: C.addMonths('2026-05-04', i), cents: 1500, desc }));
    assert.strictEqual(C.findSoftware(rows, { today: TODAY }).tools.length, 0, desc);
  }
  assert.ok(C.KNOWN.length >= 150, 'a curated table of 150+ business services');
});

test('merchant descriptors map to clean names; noise, cities and billing words are dropped', () => {
  const cases = { 'INTUIT *MAILCHIMP ATLANTA GA': 'Mailchimp', 'DOCUSIGN INC 866-219-4318 CA': 'DocuSign', 'GOOGLE *GSUITE_harborcolib': 'Google Workspace', 'ZOOM.US 888-799-9666 CA': 'Zoom', 'PADDLE.NET* NOTEWISE': 'Notewise', 'SQ *VOLUNTEERLY HQ': 'Volunteerly', 'GRANTWELL SOFTWARE BOSTON MA': 'Grantwell', 'HOMEWORKHERO.APP AUSTIN TX': 'Homeworkhero' };
  for (const [d, want] of Object.entries(cases)) assert.strictEqual(C.vendorInfo(d).name, want, d);
  assert.strictEqual(C.toolKey('InkSwift'), C.toolKey('INKSWIFT SIGN SOFTWARE'), 'card and sign-in names meet on one key');
  assert.strictEqual(C.toolKey('Ink Swift'), 'inkswift');
  assert.notStrictEqual(C.toolKey('Cloud Copy'), C.toolKey('Cloud Vault'), 'a generic first word is not a key');
});

test('several files: a row in two files counts once, two in one file both stay; limits refuse plainly', () => {
  const one = FIX('chase-business.csv');
  const p = C.parseStatements([{ name: 'a.csv', text: one }, { name: 'b.csv', text: one }]);
  assert.strictEqual(p.transactions.length, 14);
  assert.strictEqual(p.dupes, 14);
  assert.match(C.parseStatements([{ name: 'x', text: 'x'.repeat(C.LIMITS.bytes + 1) }]).error, /5 MB/);
  const rows = ['Date,Description,Amount'];
  for (let i = 0; i < C.LIMITS.rows + 1; i++) rows.push(`2026-01-01,THING ${i},-1.00`);
  assert.match(C.parseStatement(rows.join('\n')).error, /more than 20,000 rows/);
  assert.match(C.parseStatement('name,colour\nx,y\n').error, /doesn’t look like/);
  const big = ['Date,Description,Amount'];
  for (let i = 0; i < 5000; i++) big.push(`${C.addDays('2025-10-01', i % 365)},MERCHANT ${i % 400} ONLINE,-${(i % 90) + 1}.00`);
  const t0 = Date.now();
  C.findSoftware(C.parseStatement(big.join('\n')).transactions, { today: TODAY });
  assert.ok(Date.now() - t0 < 1500, `5,000 rows in ${Date.now() - t0} ms`);
});

/* ---------------- pure: sign-in exports ---------------- */

test('Google Workspace exports (app list and token log): apps, users, scopes in plain words, Google’s own left out', () => {
  const a = C.parseAccess(FIX('google-apps.csv'));
  assert.strictEqual(a.kind, 'google');
  assert.strictEqual(a.builtin, 1, 'Chrome is part of the suite');
  const nw = byName(a.apps, 'Notewise');
  assert.deepStrictEqual([nw.users, nw.scopes], [14, ['mail_read', 'cal_read', 'signin']]);
  assert.deepStrictEqual(C.riskWords(nw.scopes), ['read all mail', 'read calendars']);
  assert.ok(nw.data.includes('customer') && nw.data.includes('confidential'), 'reading mail reaches customer data');
  assert.deepStrictEqual(byName(a.apps, 'Flowbridge').scopes, ['mail_full', 'files_rw']);
  assert.deepStrictEqual(byName(a.apps, 'HomeworkHero').data, ['student'], 'rosters are student records');
  const log = C.parseAccess(FIX('google-token-log.csv'));
  assert.deepStrictEqual([byName(log.apps, 'Taskloft').users, byName(log.apps, 'Taskloft').scopes], [2, ['files_own']], 'one row per grant: distinct users');
  assert.strictEqual(log.builtin, 1);
});

test('Microsoft Entra exports (enterprise apps and sign-in logs); Graph permissions mapped', () => {
  const a = C.parseAccess(FIX('entra-apps.csv'));
  assert.strictEqual(a.kind, 'microsoft');
  assert.strictEqual(a.builtin, 1, 'Microsoft Graph is part of the suite');
  assert.deepStrictEqual(byName(a.apps, 'Notewise').scopes, ['mail_read', 'cal_read', 'offline', 'signin']);
  assert.deepStrictEqual(C.riskWords(byName(a.apps, 'Docshelf').scopes), ['read and write all files', 'read all shared sites']);
  assert.strictEqual(byName(a.apps, 'Notewise').users, 23);
  const s = C.parseAccess(FIX('entra-signins.csv'));
  assert.deepStrictEqual([s.kind, s.apps.length, s.apps[0].name, s.apps[0].users, s.builtin], ['microsoft', 1, 'Kiosko', 2, 1]);
  const map = { 'Mail.Read': 'mail_read', 'Mail.ReadWrite': 'mail_rw', 'Mail.Send': 'mail_send', 'Files.ReadWrite.All': 'files_rw', 'Files.Read.All': 'files_read', 'Files.Read': 'files_user', 'Sites.FullControl.All': 'sites_rw', 'User.Read': 'signin', 'User.Read.All': 'directory_read', 'Directory.ReadWrite.All': 'directory_rw', 'offline_access': 'offline', 'ChannelMessage.Read.All': 'chat_read', 'https://www.googleapis.com/auth/drive': 'files_rw', 'https://www.googleapis.com/auth/drive.file': 'files_own', 'https://www.googleapis.com/auth/gmail.modify': 'mail_rw', 'https://www.googleapis.com/auth/admin.directory.user': 'directory_rw', 'https://www.googleapis.com/auth/admin.directory.user.readonly': 'directory_read', 'something.weird': 'other' };
  for (const [scope, want] of Object.entries(map)) assert.strictEqual(C.scopeRisk(scope), want, scope);
  assert.deepStrictEqual(C.risksOf('Gmail, Google Drive'), ['files_rw', 'mail_read'], 'service names read as words');
  assert.match(C.parseAccess('a,b\n1,2\n').error, /app-access export/);
  assert.ok(C.breadthOf(['signin']) < C.breadthOf(['cal_read']) && C.breadthOf(['mail_read']) <= C.breadthOf(['mail_read', 'files_rw']), 'another grant never narrows');
});

test('merging sources: one row per tool, spend from the card, users and scopes from sign-ins, the export’s spelling', () => {
  const card = C.findSoftware(C.parseStatement(FIX('chase-business.csv')).transactions, { today: TODAY }).tools;
  const access = C.parseAccess(FIX('google-apps.csv')).apps;
  const list = C.parseList('Notewise\n- Canva\n2) zoom\nZoom\n').tools;
  const merged = C.mergeSources([card, access, list]);
  const names = merged.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['Canva', 'Flowbridge', 'Formly', 'HomeworkHero', 'Notewise', 'Slack', 'Zoom'].sort());
  const nw = byName(merged, 'Notewise');
  assert.deepStrictEqual([nw.spendCents, nw.users, nw.sources.sort(), nw.probable], [288000, 14, ['card', 'list', 'signin'], false], 'seen in sign-ins: not "probably" any more');
  const zoom = byName(merged, 'Zoom');
  assert.deepStrictEqual([zoom.spendCents, zoom.users, zoom.renewal], [14990, 22, '2027-06-30']);
  // Importing again keeps what a person decided.
  const mine = merged.map((t) => (t.name === 'Notewise' ? { ...t, status: 'approved', owner: 'Dana', dpa: true, notes: 'kept' } : t));
  const again = C.mergeInto(mine, [{ ...nw, users: 30, status: 'unapproved', owner: '' }, C.handTool({ name: 'Brand New Tool', spend: '120' }, TODAY).tool]);
  const n2 = byName(again.tools, 'Notewise');
  assert.deepStrictEqual([n2.status, n2.owner, n2.dpa, n2.notes, n2.users], ['approved', 'Dana', true, 'kept', 30]);
  assert.deepStrictEqual([again.added.length, again.updated.length], [1, 1]);
  assert.strictEqual(byName(again.tools, 'Brand New Tool').status, 'unapproved');
});

/* ---------------- pure: the score ---------------- */

function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function randomTool(r, i) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  return C.cleanTool({
    name: `Tool ${i}`, status: pick(C.STATUSES), contract: pick(C.CONTRACTS), dpa: r() < 0.5, sso: r() < 0.5, owner: r() < 0.5 ? 'X' : '',
    data: C.DATA.filter(() => r() < 0.25), users: r() < 0.2 ? null : Math.floor(r() * 300), spendCents: Math.floor(r() * 3000000),
    scopes: C.RISK_IDS.filter(() => r() < 0.12),
  });
}
const WORSE = [
  ['status', (t) => ({ ...t, status: { approved: 'retiring', retiring: 'review', review: 'unapproved', unapproved: 'unapproved' }[t.status] })],
  ['data', (t) => ({ ...t, data: t.data.filter((d) => d !== 'none').concat(['student']) })],
  ['scope', (t) => ({ ...t, scopes: t.scopes.concat(['mail_read']) })],
  ['users', (t) => ({ ...t, users: (t.users || 0) * 2 + 5 })],
  ['spend', (t) => ({ ...t, spendCents: t.spendCents * 2 + 10000 })],
  ['contract', (t) => ({ ...t, contract: t.contract === 'signed' ? 'clickthrough' : 'none' })],
  ['dpa', (t) => ({ ...t, dpa: false })],
  ['sso', (t) => ({ ...t, sso: false })],
  ['owner', (t) => ({ ...t, owner: '' })],
];

test('the score is monotonic: making any one thing worse never lowers a tool or the overall (400 random inventories)', () => {
  const r = rnd(42);
  for (let k = 0; k < 400; k++) {
    const tools = Array.from({ length: 1 + Math.floor(r() * 25) }, (_, i) => randomTool(r, i));
    const before = C.scoreAll(tools);
    const j = Math.floor(r() * tools.length);
    for (const [what, worse] of WORSE) {
      const t2 = C.cleanTool(worse(tools[j]));
      assert.ok(C.toolRisk(t2).raw >= C.toolRisk(tools[j]).raw - 1e-9, `${what} lowered a tool`);
      const after = C.scoreAll(tools.map((t, i) => (i === j ? t2 : t)));
      assert.ok(after.exact >= before.exact - 1e-9, `${what} lowered the overall`);
    }
  }
});

test('bands, the formula and the headline', () => {
  assert.deepStrictEqual([0, 24, 25, 49, 50, 74, 75, 100].map(C.band), ['Low', 'Low', 'Watch', 'Watch', 'High', 'High', 'Severe', 'Severe']);
  const best = tool({ status: 'approved', contract: 'signed', dpa: true, sso: true, owner: 'A', data: ['none'], users: 1, spendCents: 0 });
  const worst = tool({ status: 'unapproved', data: ['student', 'health', 'customer'], scopes: ['mail_full', 'files_rw'], users: 5000, spendCents: 5000000 });
  assert.ok(C.toolRisk(best).score <= 2 && C.toolRisk(worst).score >= 99, `${C.toolRisk(best).score} / ${C.toolRisk(worst).score}`);
  const r = C.toolRisk(tool({ status: 'review', data: ['customer'], users: 9, spendCents: 120000, contract: 'clickthrough', owner: 'Z' }));
  const f = r.factors;
  const raw = 40 * 0.65 * 0.8 * 1 * (1 + 0.5 * Math.log10(10) / 2) * (1 + 0.3 * Math.log10(1201) / Math.log10(20001)) * 1.15 * 1.35 * 1.15 * 1;
  assert.ok(Math.abs(r.raw - raw) < 1e-9 && f.dpa === 1.35 && f.owner === 1);
  assert.strictEqual(r.score, Math.round(100 * (1 - Math.exp(-raw / 100))));
  assert.strictEqual(C.scoreAll([]).score, 0);
  const h = C.headline([tool({ name: 'A', data: ['customer'], spendCents: 10000 }), tool({ name: 'B', status: 'approved', owner: 'Z', spendCents: 5000, data: ['customer'], contract: 'signed' })]);
  assert.deepStrictEqual([h.tools, h.unapproved, h.custNoContract, h.noOwnerSpendCents, h.spendCents], [2, 1, 1, 10000, 15000]);
});

test('the fix list: each delta is exactly the re-score difference; applying never raises the score; owners typed', () => {
  const b = S.build(TODAY);
  const now = C.scoreAll(b.tools);
  const list = C.fixes(b.tools);
  assert.ok(list.length >= 10, `${list.length} fixes`);
  for (const f of list) {
    const after = C.scoreAll(C.applyFix(b.tools, f));
    assert.strictEqual(f.delta, Math.round((now.exact - after.exact) * 10) / 10, f.id);
    assert.ok(f.delta >= 0.1 && after.exact <= now.exact);
  }
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].exact >= list[i].exact, 'biggest first');
  const top = C.topFixes(list, 3);
  assert.strictEqual(new Set(top.map((f) => f.toolId)).size, 3, 'three fixes, three tools');
  const kinds = new Set(list.map((f) => f.kind));
  for (const k of ['dpa', 'contract', 'sso', 'scope', 'owner', 'retire', 'overlap']) assert.ok(kinds.has(k), `a ${k} fix is offered`);
  const overlap = list.find((f) => f.kind === 'overlap' && /e-signature/.test(f.text));
  assert.match(overlap.text, /^Retire one of the two e-signature tools - InkSwift costs \$1,200 a year$/);
  const scope = list.find((f) => f.kind === 'scope' && f.toolName === 'Notewise');
  assert.strictEqual(scope.text, 'Cut Notewise’s access to read all mail - 14 people granted it');
  const owner = list.find((f) => f.kind === 'owner');
  const named = C.applyFix(b.tools, owner, { owner: '<b>Dana</b>' });
  assert.strictEqual(named.find((t) => t.id === owner.toolId).owner, 'Dana');
  assert.ok(!C.candidates(b.tools).some((c) => c.kind === 'scope' && /rosters/.test(c.text)), 'a homework tool’s rosters are its job, not a fix');
});

test('the example: 29 tools, High, the headline, the trial converting in 3 days, every fix and the overlap', () => {
  const b = S.build(TODAY);
  const sc = C.scoreAll(b.tools);
  assert.strictEqual(b.tools.length, 29);
  assert.strictEqual(sc.band, 'High');
  const h = C.headline(b.tools);
  assert.ok(h.unapproved >= 8 && h.custNoContract >= 3 && h.noOwnerSpendCents > 0);
  const radar = C.radar(b.tools, TODAY);
  assert.deepStrictEqual([radar[0].kind, radar[0].days, radar[0].title, radar[0].toolName], ['trial', 3, 'Trial converts in 3 days - decide', 'Postcraft']);
  const nw = byName(b.tools, 'Notewise');
  assert.deepStrictEqual([nw.users, C.riskWords(nw.scopes)[0], nw.status], [14, 'read all mail', 'unapproved']);
  const hh = byName(b.tools, 'HomeworkHero');
  assert.deepStrictEqual([hh.data, hh.dpa], [['student'], false]);
  assert.strictEqual(b.tools.filter((t) => t.cat === 'esign').length, 2);
  assert.ok(b.tools.some((t) => t.probable), 'one is left "probably software - check"');
  assert.strictEqual(b.requests.filter((r) => r.status === 'open').length, 2);
  let t = b.tools;
  for (const f of C.topFixes(C.fixes(t), 3)) t = C.applyFix(t, f);
  assert.ok(C.scoreAll(t).score <= sc.score - 5, 'the top three fixes take it down at least 5 points');
  // Built the same way twice: the same answer.
  assert.strictEqual(JSON.stringify(S.build(TODAY)), JSON.stringify(b));
});

/* ---------------- pure: radar and calendar ---------------- */

test('the radar: trials, renewals and contract ends in 60 days, sorted; the .ics is RFC 5545', () => {
  const tools = [
    tool({ name: 'Trialy', trial: { start: '2026-09-22', converts: '2026-10-06', cents: 100, estimated: true } }),
    tool({ name: 'Yearly; Inc, "Co"', renewal: '2026-11-01', spendCents: 90000 }),
    tool({ name: 'Far', renewal: '2027-01-15' }),
    tool({ name: 'Contracty', contractEnd: '2026-10-20', status: 'approved' }),
    tool({ name: 'Lapsed', trial: { start: '2026-09-01', converts: '2026-09-30', cents: 0 } }),
    tool({ name: 'Converted', trial: { start: '2026-06-01', converts: '2026-06-15', cents: 0, converted: true } }),
    tool({ name: 'Leaving', status: 'retiring', renewal: '2026-10-10' }),
  ];
  const r = C.radar(tools, TODAY);
  assert.deepStrictEqual(r.map((x) => [x.toolName, x.kind, x.days]), [['Lapsed', 'trial', -3], ['Trialy', 'trial', 3], ['Leaving', 'renewal', 7], ['Contracty', 'contract', 17], ['Yearly; Inc, "Co"', 'renewal', 29]]);
  assert.strictEqual(r[0].title, 'Lapsed trial probably converted 3 days ago - check');
  assert.strictEqual(r[2].title, 'Cancel Leaving before it renews in 7 days');
  const ics = C.ics({ tools, today: TODAY, now: '2026-10-03T09:00:00Z' });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'CRLF only');
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `folded: ${line}`);
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 4, 'a past trial gets no event');
  assert.match(ics, /DTSTART;VALUE=DATE:20261005\r\n/, 'the day before a trial converts');
  assert.match(ics, /DTSTART;VALUE=DATE:20261006\r\nDTEND;VALUE=DATE:20261007/, 'a contract end two weeks ahead');
  assert.match(ics, /SUMMARY:Yearly\\; Inc\\, "Co" renews in 29 days - \$900/, 'text escaped');
  assert.match(ics, /TRIGGER:PT9H/);
  // Stable UIDs: a moved date moves the event, it does not add one.
  const uids = (s) => s.match(/UID:[^\r]+/g);
  const moved = C.ics({ tools: tools.map((t) => (t.name === 'Far' ? t : { ...t, renewal: t.renewal ? C.addDays(t.renewal, 2) : null })), today: TODAY });
  assert.deepStrictEqual(uids(moved), uids(ics));
});

/* ---------------- pure: CSV export ---------------- */

test('the CSV export: every column, formula injection guarded, quotes and commas escaped, no control characters', () => {
  const csv = C.toCsv([tool({ name: '=HYPERLINK("http://x","click")', owner: '+1 555', notes: '-2+3, "quoted"\nnew line', spendCents: 120000, data: ['customer'], scopes: ['mail_read'] }), tool({ name: '@SUM(A1)', owner: 'Dana\u202eevil' })]);
  const lines = csv.replace(/^\ufeff/, '').split('\r\n');
  assert.ok(lines[0].startsWith('Tool,Category,Status,Owner,Contract,Contract ends,DPA,Data it touches,SSO,Users,Spend a year (USD)'));
  assert.ok(lines[1].startsWith(`"'=HYPERLINK(""http://x"",""click"")"`), lines[1]);
  assert.ok(lines[1].includes(",'+1 555,") && lines[1].includes('"\'-2+3, ""quoted"" new line"'), lines[1]);
  assert.ok(lines[1].includes(',1200,') && lines[1].includes('read all mail'));
  assert.ok(lines[2].startsWith("'@SUM(A1)") && !csv.includes('\u202e'));
  for (const c of ['=1', '+1', '-1', '@x']) assert.ok(C.csvCell(c).startsWith("'"), c);
  assert.strictEqual(C.csvCell('\t=1'), "' =1", 'a tab is a space, and the cell still cannot start a formula');
});

/* ---------------- pure: requests ---------------- */

test('a staff request is cleaned; a decision folds into the inventory', () => {
  assert.match(C.cleanRequest({ tool: '', name: 'A' }).error, /Which tool/);
  assert.match(C.cleanRequest({ tool: 'X tool', name: '' }).error, /your name/);
  const c = C.cleanRequest({ tool: '<b>StoryLoom</b>', name: 'Maya\u202e', why: 'x'.repeat(900), data: ['customer', 'bogus', 'customer'], trial: 'maybe', users: '3', status: 'approved' }).request;
  assert.deepStrictEqual([c.tool, c.name, c.why.length, c.data, c.trial, c.users, c.status], ['StoryLoom', 'Maya', 400, ['customer'], 'unsure', 3, undefined]);
  const b = S.build(TODAY);
  const ok = C.applyDecision(b.tools, { tool: 'StoryLoom', name: 'Maya', data: ['customer'], trial: 'yes', users: 3 }, 'approve', 'Business plan only', TODAY);
  const t = ok.tools.find((x) => x.id === ok.toolId);
  assert.deepStrictEqual([ok.added, t.status, t.owner, t.data, t.sources, t.notes], [true, 'approved', 'Maya', ['customer'], ['request'], 'Approved Oct 3 for Maya: Business plan only']);
  const no = C.applyDecision(b.tools, { tool: 'Quillmate AI', name: 'Leo', data: [], trial: 'no' }, 'decline', '', TODAY);
  assert.deepStrictEqual([no.added, no.tools.find((x) => x.id === no.toolId).status], [false, 'unapproved']);
  const nothing = C.applyDecision(b.tools, { tool: 'Never Heard Of It', name: 'Leo', trial: 'no' }, 'decline', '', TODAY);
  assert.deepStrictEqual([nothing.toolId, nothing.tools.length], [null, b.tools.length], 'declined with no trial: nothing to track');
  const trial = C.applyDecision(b.tools, { tool: 'Trialware', name: 'Leo', trial: 'yes' }, 'decline', '', TODAY);
  assert.strictEqual(trial.tools.find((x) => x.id === trial.toolId).trial.converts, '2026-10-17', 'declined with a trial running: on the radar');
});

/* ---------------- pure: vendor terms ---------------- */

test('terms readings: answers from fixed lists, bounded, stripped, every quote checked word for word', () => {
  const text = S.TERMS_EXAMPLE;
  const good = C.cleanTerms({
    vendor: 'Notewise', summary: 'It trains on your content unless an admin opts out.', confidence: 'high',
    items: {
      trainsAi: { answer: 'opt-out', detail: 'Unless you opt out.', quote: 'Notewise may use Customer Content, including meeting transcripts, to train and improve our machine learning models', confidence: 'high' },
      breachNotice: { answer: '72 hours', detail: '', quote: 'we will notify the account administrator without undue delay and in any event within 72 hours', confidence: 'high' },
      retention: { answer: '90 days after closing', quote: 'We keep your data for ninety days after you leave.', confidence: 'medium' },
      dpa: { answer: 'yes', quote: 'may request our Data Processing Addendum (DPA)', confidence: 'high' },
      location: { answer: 'United States', quote: 'stored  in data centers located\nin the United States', confidence: 'high' },
    },
  }, text);
  const get = (k) => good.items.find((i) => i.key === k);
  assert.deepStrictEqual(good.items.map((i) => i.key), C.TERM_KEYS);
  assert.deepStrictEqual([get('trainsAi').verified, get('trainsAi').worry], [true, 'warn']);
  assert.strictEqual(get('breachNotice').verified, true);
  assert.strictEqual(get('location').verified, true, 'whitespace differences are not differences');
  assert.deepStrictEqual([get('retention').verified, get('retention').quote.length > 0], [false, true], 'a paraphrase is kept, marked unverified');
  assert.strictEqual(good.unverified, 1);
  assert.deepStrictEqual([get('cancellation').answer, get('cancellation').noQuote, get('cancellation').worry], ['Not stated', true, 'warn']);
  assert.match(C.termsNote(good, TODAY), /^Terms read Oct 3: trains AI opt-out; DPA offered yes; breach notice 72 hours/);
  // Hostile output.
  const bad = C.cleanTerms({ vendor: '<img src=x onerror=alert(1)>Acme\u202e', summary: 'S'.repeat(9000), confidence: 'certain', items: { trainsAi: { answer: 'definitely', detail: '<script>x</script>', quote: 'Never ever train, promise, really truly.', confidence: 'sure' }, retention: { answer: { a: 1 }, quote: 'A'.repeat(5000) }, location: { answer: 'Mars', quote: 12345 }, bogus: { answer: 'yes' } } }, text);
  assert.deepStrictEqual([bad.vendor, bad.summary.length, bad.confidence], ['Acme', 300, 'low']);
  assert.deepStrictEqual([bad.items[0].answer, bad.items[0].confidence, bad.items[0].verified, bad.items[0].detail], ['unclear', 'low', false, 'x']);
  assert.ok(bad.items.every((i) => !/[<>]/.test(JSON.stringify(i)) && i.quote.length <= 600));
  assert.ok(!bad.items.some((i) => i.key === 'bogus'));
  assert.strictEqual(C.cleanTerms({ readable: false }, text), null);
  assert.strictEqual(C.cleanTerms({ items: {} }, text), null, 'nothing answered: nothing to show');
  assert.strictEqual(C.matcher(text)('personal data'), false, 'under 12 characters proves nothing');
});

/* ---------------- the page ---------------- */

test('the page: relative links, no inline script or handlers, the banner, storage wrapped', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js.replace(/\.on[a-z]+ =/g, '')), 'no handler written into markup');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'no other storage access');
  assert.ok(!/<script/i.test(js));
  assert.match(js, /Read on this device\. Nothing is uploaded\./);
  assert.match(js, /This is an example library system - try the fixes, then check your own\./);
  assert.match(js, /Not legal advice - read the contract\./);
  for (const f of ['server.js', 'lib/ai.js', 'lib/orgs.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|text|tools|vendor|why|name)\b/.test(src), `${f} logs a body`);
  }
});

test('the files never leave the page: every request the page makes, and what it carries', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const calls = [...js.matchAll(/api\('(GET|POST|PUT|PATCH|DELETE)', '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
  const allowed = ['GET api/me', 'GET api/orgs', 'POST api/orgs', 'GET api/orgs/', 'PUT api/orgs/', 'DELETE api/orgs/', 'PATCH api/orgs/', 'POST api/orgs/', 'GET api/r/', 'POST api/r/', 'DELETE api/r/', 'POST api/terms', 'POST api/auth/', 'POST api/auth/logout', 'GET api/auth/billing'];
  for (const c of calls) assert.ok(allowed.includes(c), `unexpected request: ${c}`);
  assert.strictEqual((js.match(/\bfetch\(/g) || []).length, 2, 'fetch only in api() and the verify resend');
  assert.ok(!/XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(js));
  assert.match(js, /function savedBody\(\) \{ return \{ name: state\.org\.name, kind: state\.org\.kind, tools: state\.tools\.map\(C\.toSaved\), done: state\.done \}; \}/);
  assert.strictEqual((js.match(/api\('(PUT|POST)', 'api\/orgs[^']*'[^)]*savedBody\(\)\)/g) || []).length, 2, 'both inventory saves send savedBody()');
  // Reading files makes no request at all.
  const importFns = js.slice(js.indexOf('/* ---------------- find the tools'), js.indexOf('/* ---------------- read a vendor'));
  assert.ok(importFns.length > 2000 && !/api\(|fetch\(/.test(importFns), 'reading a statement or export makes no request');
  // ...and the server has no route that would take one.
  const routes = app._router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  const own = routes.filter((r) => !/^(GET|POST|PUT|DELETE|PATCH) \/api\/auth|^GET \*$|^GET \/api\/(health|meta|me)|^GET \/api\/health,\/healthz|^(GET|ACL) \/r\/:rid/.test(r));
  assert.deepStrictEqual(own.sort(), ['DELETE /api/orgs/:id', 'DELETE /api/r/:rid/:qid', 'GET /api/orgs', 'GET /api/orgs/:id', 'GET /api/orgs/:id/requests', 'GET /api/r/:rid', 'PATCH /api/orgs/:id/link', 'POST /api/orgs', 'POST /api/orgs/:id/requests/:qid', 'POST /api/r/:rid', 'POST /api/terms', 'PUT /api/orgs/:id'].sort());
});

test('memory store and fake model refuse Cloud Run; every Firestore path is prefixed', () => {
  for (const [file, env] of [['lib/store.js', { SHADOW_MEMORY: '1' }], ['lib/fakeai.js', { SHADOW_FAKE_AI: '1' }], ['server.js', { SHADOW_FAKE_AI: '1', SHADOW_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require('./${file}')`], { cwd: ROOT, env: { ...process.env, ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${file} must refuse on Cloud Run`);
    assert.match(r.stderr, /refused on Cloud Run/);
  }
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], { cwd: ROOT, env: { ...process.env, SHADOW_MEMORY: '', SHADOW_COLLECTION_PREFIX: 'shadow_' }, encoding: 'utf8' });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'store.js'), 'utf8');
  assert.ok(/SHADOW_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 9);
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const TERMS = S.TERMS_EXAMPLE;

test('signed out: the page, the example and its files work with zero model calls; nothing private does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.limits.tools, meta.limits.openRequests, meta.limits.orgs], [500, 200, 3]);
  for (const f of ['shadow-core.js', 'sample.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['POST', '/api/terms'], ['GET', '/api/orgs'], ['POST', '/api/orgs'], ['GET', '/api/orgs/o0123456789ab'], ['PUT', '/api/orgs/o0123456789ab'], ['DELETE', '/api/orgs/o0123456789ab'], ['GET', '/api/orgs/o0123456789ab/requests']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  assert.strictEqual((await anon('POST', '/api/terms', { text: TERMS })).status, 401);
  assert.strictEqual((await anon('POST', '/api/terms', { text: 'A'.repeat(600 * 1024) })).status, 401, 'the gate answers before the big parser');
  assert.strictEqual((await anon('POST', '/api/orgs', { name: 'x', tools: [], pad: 'x'.repeat(1100 * 1024) })).status, 401, 'the save parser runs after sign-in');
  for (const p of ['/api/statement', '/api/upload', '/api/csv']) assert.strictEqual((await anon('POST', p, { csv: 'Date,Description,Amount' })).status, 404, 'there is nowhere to send a statement');
  assert.strictEqual((await anon('PATCH', '/api/orgs/o0123456789ab/link', { x: 'x'.repeat(200 * 1024) })).status, 413, 'every other route keeps the small limit');
  // The sample is built from the same rules, in the browser, signed out.
  const b = S.build(TODAY);
  assert.ok(C.fixes(b.tools).length && C.radar(b.tools, TODAY).length);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the terms route’s gates come before its parser, in order; only it holds a model client', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/terms', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/orgs', 'post').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/orgs/:id', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  for (const [p, m] of [['/api/orgs', 'get'], ['/api/orgs/:id', 'get'], ['/api/orgs/:id', 'delete'], ['/api/orgs/:id/requests', 'get'], ['/api/orgs/:id/requests/:qid', 'post'], ['/api/orgs/:id/link', 'patch']]) assert.strictEqual(layer(p, m).route.stack[0].handle.name, 'requireUser', `${m} ${p}`);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1);
});

let pat;

test('read a vendor’s terms: text checked before any spend, one metered call, quotes verified, nothing stored', async () => {
  pat = await register('pat.terms@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  assert.strictEqual((await pat('POST', '/api/terms', {})).status, 400);
  assert.strictEqual((await pat('POST', '/api/terms', { text: 'too short' })).status, 400);
  assert.strictEqual((await pat('POST', '/api/terms', { text: 'x'.repeat(C.LIMITS.termsText + 1) })).status, 400);
  assert.strictEqual((await pat('POST', '/api/terms', { text: 'x'.repeat(600 * 1024) })).status, 413, 'over the 512 KB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const MARK = 'PASTEDTEXTMARKER';
  const r = await pat('POST', '/api/terms', { text: `${TERMS}\n${MARK}`, vendor: 'Notewise' });
  assert.strictEqual(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.text.startsWith(' '), 'the answer streams whitespace first');
  const items = Object.fromEntries(r.data.review.items.map((i) => [i.key, i]));
  assert.deepStrictEqual([items.trainsAi.answer, items.trainsAi.verified], ['opt-out', true]);
  assert.deepStrictEqual([items.breachNotice.answer, items.breachNotice.verified], ['72 hours', true]);
  assert.deepStrictEqual([items.retention.verified, r.data.review.unverified], [false, 1], 'the fake paraphrases one quote: kept, flagged');
  assert.strictEqual(items.dpa.answer, 'yes');
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const inj = await pat('POST', '/api/terms', { text: `${TERMS}\nINJECT` });
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !inj.text.includes('\\u202e'), 'no markup reaches the page');
  assert.ok(inj.data.review.items.every((i) => i.quote.length <= 600 && ['high', 'medium', 'low'].includes(i.confidence) && i.answer.length <= 80));
  assert.strictEqual(inj.data.review.items.find((i) => i.key === 'trainsAi').verified, false, 'an invented quote is never verified');
  const not = await pat('POST', '/api/terms', { text: `${'Lorem ipsum dolor sit amet. '.repeat(20)} NOTTERMS` });
  assert.deepStrictEqual([not.status, /doesn’t read like/.test(not.data.error)], [200, true], 'after the stream starts, a failure is a 200 {error}');
  assert.match((await pat('POST', '/api/terms', { text: `${TERMS}\nMAXTOKENS` })).data.error, /ran longer/);
  const up = await pat('POST', '/api/terms', { text: `${TERMS}\nUPSTREAM401` });
  assert.ok(up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  assert.match((await pat('POST', '/api/terms', { text: `${TERMS}\nUPSTREAM529` })).data.error, /AI is busy/);
  const after = store._dump();
  assert.strictEqual(after, dump, 'reading stores nothing');
  assert.ok(!after.includes(MARK) && !after.includes('Customer Content'), 'no pasted text anywhere');
});

test('an unconfirmed free account gets the verify-email 403, before any model call or big body', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/terms', { text: TERMS });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/shadow/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/terms', { text: 'A'.repeat(700 * 1024) })).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('POST', '/api/orgs', { name: 'Eve Co', tools: [] })).status, 201, 'saving needs no AI and no confirmed address');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
});

test('out of credit: 402 before any model call - and before the big body is read', async () => {
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  const r = await cal('POST', '/api/terms', { text: TERMS });
  assert.strictEqual(r.status, 402);
  assert.match(r.data.detail, /Top up/);
  assert.strictEqual((await cal('POST', '/api/terms', { text: 'A'.repeat(700 * 1024) })).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

let ana;
let orgId;
let rid;

test('a saved inventory holds tools and nothing else - however much a request carries', async () => {
  ana = await register('ana.owner@example.com');
  const files = S.files(TODAY);
  const p = C.parseStatements(files.card);
  const b = S.build(TODAY);
  const MARK = 'RAWCSVMARKER';
  const body = {
    name: 'Harbor County Library', kind: 'public',
    tools: b.tools.map((t) => ({ ...t, transactions: p.transactions.slice(0, 5), desc: 'NOTEWISE.AI SUBSCR 888-555-0101 CA', csv: MARK })),
    done: [{ id: 'dpa:tc3b84dcfcd2a', text: 'Got a DPA', at: '2099-01-01' }, { id: '<bad>', text: 'x' }],
    csv: files.card[0].text + MARK, transactions: p.transactions, export: files.access[0].text, rid: 'AAAAAAAAAAAAAAAAAAAAAA', ownerId: 'someone-else',
  };
  const r = await ana('POST', '/api/orgs', body);
  assert.strictEqual(r.status, 201, JSON.stringify(r.data).slice(0, 300));
  orgId = r.data.org.id;
  rid = r.data.link.rid;
  assert.ok(O.ORG_ID_RE.test(orgId) && O.RID_RE.test(rid) && rid !== 'AAAAAAAAAAAAAAAAAAAAAA', 'the link id is the server’s');
  assert.strictEqual(r.data.org.tools.length, 29);
  assert.deepStrictEqual(r.data.org.done, [{ id: 'dpa:tc3b84dcfcd2a', text: 'Got a DPA', at: TODAY <= new Date().toISOString().slice(0, 10) ? new Date().toISOString().slice(0, 10) : TODAY }].map((d) => ({ ...d, at: new Date().toISOString().slice(0, 10) })));
  const dump = store._dump();
  for (const bad of [MARK, 'transactions', 'NOTEWISE.AI SUBSCR', 'Transaction Date', 'googleusercontent', 'someone-else', 'ana.owner@example.com']) assert.ok(!dump.includes(bad), `not stored: ${bad}`);
  const doc = await store.get(`orgs/${uidOf('ana.owner@example.com')}/items`, orgId);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['createdAt', 'done', 'id', 'kind', 'name', 'rid', 'tools', 'updatedAt']);
  assert.deepStrictEqual(Object.keys(doc.tools[0]).sort(), C.SAVED_FIELDS.slice().sort());
  const link = await store.get('links', rid);
  assert.deepStrictEqual(Object.keys(link).sort(), ['accepting', 'createdAt', 'id', 'orgName']);
  // Read back, edited, listed.
  const got = await ana('GET', `/api/orgs/${orgId}`);
  assert.deepStrictEqual([got.data.org.name, got.data.link.accepting, got.data.open], ['Harbor County Library', true, 0]);
  const tools = got.data.org.tools.map((t) => (t.name === 'Notewise' ? { ...t, owner: 'Dana Ruiz', dpa: true } : t));
  const put = await ana('PUT', `/api/orgs/${orgId}`, { name: 'Harbor County Libraries', kind: 'public', tools, done: [] });
  assert.strictEqual(put.status, 200);
  assert.strictEqual((await store.get('links', rid)).orgName, 'Harbor County Libraries', 'the link says the new name');
  const list = (await ana('GET', '/api/orgs')).data.orgs;
  assert.deepStrictEqual(list.map((o) => [o.name, o.tools]), [['Harbor County Libraries', 29]]);
  assert.ok(Number.isInteger(list[0].score) && list[0].band);
});

test('limits and ownership: 500 tools, 3 inventories, nobody reads anyone else’s, delete takes the link and requests', async () => {
  const many = Array.from({ length: 501 }, (_, i) => ({ name: `Plan ${i}` }));
  assert.strictEqual((await ana('POST', '/api/orgs', { name: 'Big', tools: many })).status, 400);
  assert.strictEqual((await ana('POST', '/api/orgs', { name: '', tools: [] })).status, 400);
  assert.strictEqual((await ana('POST', '/api/orgs', { name: 'X', tools: 'nope' })).status, 400);
  const ok = await ana('POST', '/api/orgs', { name: 'Five hundred', tools: Array.from({ length: 500 }, (_, i) => ({ name: `Plan ${i}` })) });
  assert.strictEqual(ok.data.org.tools.length, 500);
  assert.strictEqual((await ana('POST', '/api/orgs', { name: 'Third', tools: [] })).status, 201);
  const fourth = await ana('POST', '/api/orgs', { name: 'Fourth', tools: [] });
  assert.deepStrictEqual([fourth.status, /up to 3/.test(fourth.data.error)], [409, true]);
  const olly = await register('olly.other@example.com');
  for (const [m, p, b] of [['GET', `/api/orgs/${orgId}`], ['PUT', `/api/orgs/${orgId}`, { name: 'Mine now', tools: [] }], ['DELETE', `/api/orgs/${orgId}`], ['GET', `/api/orgs/${orgId}/requests`], ['PATCH', `/api/orgs/${orgId}/link`, { accepting: false }], ['GET', '/api/orgs/zzz'], ['GET', '/api/orgs/o0123456789ab']]) {
    assert.strictEqual((await olly(m, p, b)).status, 404, `${m} ${p}`);
  }
  assert.deepStrictEqual((await olly('GET', '/api/orgs')).data.orgs, [], 'a new account sees no inventory - not someone else’s');
  // Delete one: its link and requests go with it.
  const tmp = await ana('DELETE', `/api/orgs/${ok.data.org.id}`);
  assert.strictEqual(tmp.status, 200);
  assert.strictEqual(await store.get('links', ok.data.link.rid), null);
  assert.strictEqual((await ana('GET', `/api/orgs/${ok.data.org.id}`)).status, 404);
  let last;
  const flood = await register('flood@example.com');
  const made = await flood('POST', '/api/orgs', { name: 'F', tools: [] });
  for (let i = 0; i < 121; i++) last = await flood('PUT', `/api/orgs/${made.data.org.id}`, { name: 'F', tools: [] });
  assert.strictEqual(last.status, 429, 'saves per account are limited');
});

test('a staff request: no account, as themselves only, their own list, limits; the owner approves and declines', async () => {
  const before = await modelCalls();
  const staff = client();
  const page = await staff('GET', `/r/${rid}`);
  assert.strictEqual(page.status, 200);
  assert.ok(page.text.includes('<base href="../">') && page.headers.get('referrer-policy') === 'no-referrer');
  const view = await staff('GET', `/api/r/${rid}`);
  assert.deepStrictEqual(view.data, { org: { name: 'Harbor County Libraries' }, accepting: true, mine: [] });
  assert.ok(!view.setCookie.length, 'a GET never sets a cookie');
  assert.ok(!/Notewise|tools|score/.test(view.text), 'nothing from the inventory');
  assert.strictEqual((await staff('POST', `/api/r/${rid}`, { tool: 'X', name: 'Maya' })).status, 400);
  const sent = await staff('POST', `/api/r/${rid}`, { tool: 'StoryLoom', name: 'Maya (Children’s desk)', why: 'Summer reading', data: ['customer'], trial: 'yes', users: 3, status: 'approved', conditions: 'self-approved', keyHash: 'forged' });
  assert.strictEqual(sent.status, 201);
  assert.deepStrictEqual([sent.data.request.status, sent.data.request.conditions], ['open', ''], 'a staff member cannot approve their own request');
  assert.ok(sent.setCookie.some((c) => /^shadow_k=[A-Za-z0-9_-]{22}; Path=\/shadow\/; .*HttpOnly/.test(c)), 'the browser key: HttpOnly, this app’s path');
  const qid = sent.data.request.id;
  assert.ok(O.QID_RE.test(qid));
  assert.strictEqual((await staff('GET', `/api/r/${rid}`)).data.mine.length, 1);
  // Another browser sees none of it and cannot withdraw it.
  const other = client();
  await other('POST', `/api/r/${rid}`, { tool: 'Quillmate AI', name: 'Leo', trial: 'no' });
  assert.deepStrictEqual((await other('GET', `/api/r/${rid}`)).data.mine.map((r) => r.tool), ['Quillmate AI']);
  assert.strictEqual((await other('DELETE', `/api/r/${rid}/${qid}`)).status, 404);
  const stored = await store.get(`requests/${rid}/items`, qid);
  assert.ok(stored.keyHash && stored.keyHash !== 'forged' && !JSON.stringify(stored).includes(staff.cookies.shadow_k), 'the key is never stored, only its hash');
  // The owner's queue: both, names included, no key hashes.
  const q = await ana('GET', `/api/orgs/${orgId}/requests`);
  assert.deepStrictEqual([q.data.open, q.data.requests.map((r) => r.tool).sort()], [2, ['Quillmate AI', 'StoryLoom']]);
  assert.ok(!/keyHash/.test(q.text));
  assert.strictEqual((await ana('GET', `/api/orgs/${orgId}`)).data.open, 2);
  // Approve with conditions: the inventory updates itself.
  assert.strictEqual((await ana('POST', `/api/orgs/${orgId}/requests/${qid}`, { decision: 'maybe' })).status, 400);
  const yes = await ana('POST', `/api/orgs/${orgId}/requests/${qid}`, { decision: 'approve', conditions: '<b>Business plan</b> only' });
  assert.strictEqual(yes.status, 200, yes.text);
  const story = yes.data.org.tools.find((t) => t.name === 'StoryLoom');
  assert.deepStrictEqual([story.status, story.owner, story.notes.includes('Business plan only'), yes.data.org.tools.length], ['approved', 'Maya (Children’s desk)', true, 30]);
  assert.strictEqual((await ana('POST', `/api/orgs/${orgId}/requests/${qid}`, { decision: 'decline' })).status, 409, 'decided once');
  const mine = (await staff('GET', `/api/r/${rid}`)).data.mine[0];
  assert.deepStrictEqual([mine.status, mine.conditions], ['approved', 'Business plan only'], 'the staff member sees the answer');
  assert.strictEqual((await staff('DELETE', `/api/r/${rid}/${qid}`)).status, 409, 'a decided request cannot be withdrawn');
  const leo = (await ana('GET', `/api/orgs/${orgId}/requests`)).data.requests.find((r) => r.tool === 'Quillmate AI');
  const no = await ana('POST', `/api/orgs/${orgId}/requests/${leo.id}`, { decision: 'decline' });
  assert.strictEqual(no.data.org.tools.find((t) => t.name === 'Quillmate AI').status, 'unapproved');
  // Withdraw your own open one.
  const third = await staff('POST', `/api/r/${rid}`, { tool: 'Padlet', name: 'Maya', trial: 'no' });
  assert.strictEqual((await staff('DELETE', `/api/r/${rid}/${third.data.request.id}`)).status, 200);
  assert.strictEqual((await ana('GET', `/api/orgs/${orgId}/requests`)).data.open, 0, 'withdrawn is gone from the queue');
  // Paused: the link says so and takes nothing.
  await ana('PATCH', `/api/orgs/${orgId}/link`, { accepting: false });
  assert.strictEqual((await staff('GET', `/api/r/${rid}`)).data.accepting, false);
  assert.strictEqual((await staff('POST', `/api/r/${rid}`, { tool: 'Paused Tool', name: 'Maya' })).status, 409);
  await ana('PATCH', `/api/orgs/${orgId}/link`, { accepting: true });
  // A stranger with a wrong link: 404, and guessing is limited.
  const guesser = client();
  assert.strictEqual((await guesser('GET', '/api/r/BBBBBBBBBBBBBBBBBBBBBB')).status, 404);
  assert.strictEqual((await guesser('GET', '/api/r/not-a-link')).status, 404);
  for (let i = 0; i < 30; i++) await guesser('GET', `/api/r/${String(i).padStart(22, 'C')}`);
  assert.strictEqual((await guesser('GET', `/api/r/${rid}`)).status, 429, 'too many wrong links from one address');
  // New requests per address are limited.
  const spammer = client();
  let last;
  for (let i = 0; i < 11; i++) last = await spammer('POST', `/api/r/${rid}`, { tool: `Spam ${i}`, name: 'Bot' });
  assert.strictEqual(last.status, 429);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call anywhere in requests');
});

test('the open-request ceiling: 200 waiting per organisation', async () => {
  const owner = await register('busy.owner@example.com');
  const made = await owner('POST', '/api/orgs', { name: 'Busy', tools: [] });
  const r2 = made.data.link.rid;
  for (let i = 0; i < 200; i++) await store.set(`requests/${r2}/items`, `q${String(i).padStart(16, '0')}`, { tool: `T${i}`, name: 'x', status: 'open', keyHash: 'h', at: new Date().toISOString() });
  const res = await client()('POST', `/api/r/${r2}`, { tool: 'One more', name: 'Late' });
  assert.deepStrictEqual([res.status, /a lot of requests waiting/.test(res.data.error)], [429, true]);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.set('trust proxy', 1);
  host.use('/shadow', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/shadow`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
