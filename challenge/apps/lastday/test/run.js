// Pure rules first (reading files, guessing columns, matching, every
// verdict, the summary and the per-person view, the checklist, the request
// reader, masking, the AI's checks, exports, the inventory), then the demo
// on days across a year, then hostile files, then the worker in a real
// worker thread, then the page's own promises, then end to end against the
// memory store and the fake model:
//   LASTDAY_MEMORY=1 LASTDAY_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /lastday, the way
// the lab mounts it, so the auth cookie, the budget gate and each route's
// parser order are exercised as deployed. Model calls are counted from the
// identity usage rows, and what reached "the model" is read from the fake's
// own log.
//
// Every person and address here is made up; addresses are built with AT so
// no file carries one.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const express = require('express');

if (process.env.LASTDAY_MEMORY !== '1' || process.env.LASTDAY_FAKE_AI !== '1') {
  console.error('run with LASTDAY_MEMORY=1 LASTDAY_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/lastday-core');
const D = require('../public/demo');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const at = (local, dom) => local + AT + (dom || 'acme.example');
const TODAY = '2026-11-03'; // a Tuesday

/* ---------------- helpers ---------------- */

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const csv = (rows) => rows.map((r) => r.join(',')).join('\n') + '\n';

/** Parse, guess and analyse, the way the page does it. */
function analyse(idpText, apps, settings, today, extra) {
  const e = C.createEngine();
  const pi = e.parse({ id: 'idp', role: 'idp', name: 'idp.csv', text: idpText });
  const as = apps.map((a, i) => { const p = e.parse({ id: 'a' + i, role: 'app', name: a.name || 'app.csv', text: a.text, n: i + 1 }); return { id: 'a' + i, name: a.label || p.appName, map: Object.assign({}, p.guess.map, (a.map || {})) }; });
  const s = Object.assign({}, C.DEFAULT_SETTINGS, settings || {});
  const r = e.analyse(Object.assign({ idp: { id: 'idp', map: pi.guess.map }, apps: as, settings: s, today: today || TODAY, idpKind: s.idp }, extra || {}));
  r.engine = e; r.pi = pi;
  return r;
}
function demo(today) {
  const ex = D.exportsFor(today);
  return analyse(ex.idp.text, ex.apps, C.cleanInventory(D.inventory()).inventory.settings, today, { ws: 'demo' });
}
const pick = (rows) => rows.map((r) => `${r.verdict}${r.critical ? '!' : ''} ${r.appName} ${r.name}`);

/* ================================================================== *
 * Reading files
 * ================================================================== */

test('CSV: quotes, doubled quotes, line breaks in quotes, CRLF and CR, a BOM, the delimiter sniffed, sep=, a preamble, no header, ragged rows, duplicate headers', () => {
  let t = C.parseTable('\uFEFFName,Email\r\n"Reyes, Jordan","jo""rdan' + AT + 'x.example"\r\n"Line\nbreak",b' + AT + 'x.example\r\n');
  assert.deepStrictEqual(t.headers, ['Name', 'Email']);
  assert.deepStrictEqual(t.rows[0], ['Reyes, Jordan', 'jo"rdan' + AT + 'x.example']);
  assert.strictEqual(t.rows[1][0], 'Line break', 'a line break inside quotes stays in the cell (folded to a space)');
  assert.strictEqual(C.parseTable('a;b;c\r1;2;3\r4;5;6').delimiterName, 'semicolon');
  assert.strictEqual(C.parseTable('a\tb\tc\n1\t2\t3\n').delimiterName, 'tab');
  assert.strictEqual(C.parseTable('a|b|c\n1|2|3\n').delimiterName, 'pipe');
  t = C.parseTable('sep=;\nEmail;Name\n' + at('a') + ';A B\n');
  assert.deepStrictEqual([t.delimiterName, t.headers], ['semicolon', ['Email', 'Name']]);
  t = C.parseTable('User export\nGenerated Nov 3\nEmail,Name,Status\n' + at('a') + ',A B,Active\n');
  assert.deepStrictEqual([t.preamble, t.headers[0], t.rows.length], [2, 'Email', 1]);
  t = C.parseTable(at('a') + ',Ann Lee,Active\n' + at('b') + ',Bo Chen,Suspended\n');
  assert.deepStrictEqual([t.header, t.headers, t.rows.length], [false, ['Column 1', 'Column 2', 'Column 3'], 2]);
  t = C.parseTable('Email,Name,Role\n' + at('a') + ',A\n' + at('b') + ',B,Admin,extra\n' + at('c') + ',C,Member\n' + at('d') + ',D,Member\n' + at('e') + ',E,Member\n');
  assert.deepStrictEqual([t.ragged, t.rows[0], t.rows[1]], [2, [at('a'), 'A', ''], [at('b'), 'B', 'Admin']], 'short rows padded, long ones cut, both counted');
  t = C.parseTable('Email,Email,Name\nx,y,z\n');
  assert.deepStrictEqual(t.headers, ['Email', 'Email (2)', 'Name']);
  t = C.parseTable('Email,Name\n"' + at('a') + ',A B\n');
  assert.strictEqual(t.openQuote, true, 'an unclosed quote is noted');
  assert.strictEqual(C.parseTable('').empty, true);
});

test('dates: ISO with times and zones, slashes either way, month names with times, Unix seconds and milliseconds only when mapped, "Never"', () => {
  assert.strictEqual(C.readDate('2026-08-01T09:12:44.000Z'), '2026-08-01');
  assert.strictEqual(C.readDate('2026/10/01 14:32:11'), '2026-10-01');
  assert.strictEqual(C.readDate('10/01/2026'), '2026-10-01');
  assert.strictEqual(C.readDate('10/01/2026', 'dmy'), '2026-01-10');
  assert.strictEqual(C.readDate('25/12/2026'), '2026-12-25', 'a first part over 12 is the day');
  assert.strictEqual(C.readDate('Aug 1, 2026 9:12:44 AM'), '2026-08-01');
  assert.strictEqual(C.readDate('Sat, Aug 1, 2026'), '2026-08-01');
  assert.strictEqual(C.readDate('1 Aug 2026'), '2026-08-01');
  assert.strictEqual(C.readDate('1785571200'), null, 'a bare number is an id unless the column is a date');
  assert.strictEqual(C.readDate('1785571200', 'mdy', true), '2026-08-01');
  assert.strictEqual(C.readDate('1785571200000', 'mdy', true), '2026-08-01');
  assert.strictEqual(C.readDate('2026-02-30'), null);
  assert.ok(C.isNever('Never logged in') && C.isNever('never') && !C.isNever('2026-01-01'));
  assert.strictEqual(C.dateOrder(['13/01/2026', '01/02/2026']), 'dmy');
});

/* ================================================================== *
 * Guessing columns
 * ================================================================== */

const IDP_EXPORTS = {
  okta: ['Username,First name,Last name,Primary email,Title,Status,Last login,Status changed', `${at('ann.lee')},Ann,Lee,${at('ann.lee')},Hygienist,ACTIVE,2026-10-30T08:00:00.000Z,`, `${at('bo.chen')},Bo,Chen,${at('bo.chen')},Dentist,SUSPENDED,2026-07-01T08:00:00.000Z,2026-07-02T09:00:00.000Z`],
  entra: ['id,displayName,userPrincipalName,mail,accountEnabled,userType,createdDateTime,lastSignInDateTime', `1,Ann Lee,${at('ann.lee', 'acme.onmicrosoft.example')},${at('ann.lee')},True,Member,2024-01-01T00:00:00Z,2026-10-30T08:00:00Z`, `2,Bo Chen,${at('bo.chen', 'acme.onmicrosoft.example')},${at('bo.chen')},False,Member,2024-01-01T00:00:00Z,2026-07-01T08:00:00Z`],
  google: ['First Name [Required],Last Name [Required],Email Address [Required],Status [READ ONLY],Last Sign In [READ ONLY],Org Unit Path [Required]', `Ann,Lee,${at('ann.lee')},Active,2026/10/30 08:00:00,/`, `Bo,Chen,${at('bo.chen')},Suspended,Never logged in,/`],
  jumpcloud: ['email,username,firstname,lastname,activated,suspended,account_locked', `${at('ann.lee')},annlee,Ann,Lee,true,false,false`, `${at('bo.chen')},bochen,Bo,Chen,true,true,false`],
};

test('identity provider exports: Okta, Entra ID, Google Workspace and JumpCloud headers recognised, the provider named, the status read', () => {
  const want = { okta: { email: 3, first: 1, last: 2, status: 5, lastLogin: 6, changed: 7, name: -1 }, entra: { email: 2, name: 1, status: 4, lastLogin: 7, alias: 3, changed: -1 }, google: { email: 2, first: 0, last: 1, status: 3, lastLogin: 4 }, jumpcloud: { email: 0, first: 2, last: 3, status: 5 } };
  for (const [kind, lines] of Object.entries(IDP_EXPORTS)) {
    const t = C.parseTable(lines.join('\n'));
    const g = C.guessColumns('idp', t.headers, t.rows);
    for (const [f, c] of Object.entries(want[kind])) assert.strictEqual(g.map[f], c, `${kind}: ${f} -> ${t.headers[c]} (got ${t.headers[g.map[f]]})`);
    assert.strictEqual(C.guessIdp(t.headers), kind, kind + ' is named');
    const users = C.buildIdp(t, g.map, {}).users;
    assert.deepStrictEqual(users.map((u) => u.status), ['active', 'suspended'], kind + ': Bo is suspended');
    assert.deepStrictEqual(users.map((u) => u.name), ['Ann Lee', 'Bo Chen']);
  }
  assert.strictEqual(C.idpStatus('False', 'accountEnabled'), 'suspended');
  assert.strictEqual(C.idpStatus('true', 'suspended'), 'suspended');
  assert.strictEqual(C.idpStatus('DEPROVISIONED', 'Status'), 'deprovisioned');
  assert.strictEqual(C.idpStatus('PROVISIONED', 'Status'), 'pending');
  assert.strictEqual(C.idpStatus('LOCKED_OUT', 'Status'), 'active', 'locked out is still a current person');
  assert.strictEqual(C.idpStatus('Inactive', 'Status'), 'suspended', '"inactive" is not "active"');
});

test('app exports: names, addresses, roles and last active found under awkward headers; a status column holding roles is read as the role; a title is never a name', () => {
  const cases = [
    [['username,email,status,billing-active,has-2fa,fullname,displayname', `ann,${at('ann.lee')},Admin,1,1,Ann Lee,ann`, `bo,${at('bo.chen')},Deactivated,0,1,Bo Chen,bo`, `bot,${at('bot')},Bot,0,0,Build Bot,bot`], { email: 1, name: 5, role: 2 }],
    [['login,name,email,role,last_active', `annlee,Ann Lee,${at('ann.lee')},owner,2026-10-30`, `bochen,Bo Chen,${at('bo.chen')},member,2026-01-30`], { email: 2, name: 1, role: 3, lastActive: 4 }],
    [['User Name,Profile,Is Admin,Active,Last Login Date', `${at('ann.lee')},Standard User,true,true,10/30/2026`, `${at('bo.chen')},Standard User,false,false,01/30/2026`], { email: 0, role: 2, status: 3, lastActive: 4 }],
    [['Email,First Name,Last Name,User Type,Role,Last Sign In', `${at('ann.lee')},Ann,Lee,Licensed,Owner,2026/10/30 09:14`, `${at('bo.chen')},Bo,Chen,Basic,Member,2026/01/30 09:14`], { email: 0, first: 1, last: 2, role: 4, lastActive: 5 }],
    [['Member,Job title,Email,Created,Last seen', `Ann Lee,Office manager,${at('ann.lee')},2020-01-01,2026-10-30`, `Bo Chen,Front desk,${at('bo.chen')},2021-01-01,2026-01-30`], { name: 0, email: 2, lastActive: 4 }],
  ];
  cases.forEach(([lines, want], n) => {
    const t = C.parseTable(lines.join('\n'));
    const g = C.guessColumns('app', t.headers, t.rows);
    for (const [f, c] of Object.entries(want)) assert.strictEqual(g.map[f], c, `case ${n + 1}: ${f} -> ${t.headers[c]} (got ${t.headers[g.map[f]]})`);
  });
  const t5 = C.parseTable(cases[4][0].join('\n'));
  const g5 = C.guessColumns('app', t5.headers, t5.rows);
  assert.notStrictEqual(g5.map.lastActive, 3, 'a Created date is never the last activity');
  const hl = C.parseTable(`${at('ann.lee')},Ann Lee,Admin,2026-10-30\n${at('bo.chen')},Bo Chen,Member,2026-01-30\n`);
  const gh = C.guessColumns('app', hl.headers, hl.rows, !hl.header);
  assert.deepStrictEqual([gh.map.email, gh.map.name, gh.map.role], [0, 1, 2], 'a headerless file is guessed from its values');
  assert.deepStrictEqual(C.mappingProblems('app', { email: -1, name: -1, last: -1 }), ['Choose the email column (or at least a name column) - there is nothing to match on otherwise.']);
  assert.deepStrictEqual(C.mappingProblems('idp', { email: 1, name: 1 }), ['One column is chosen for two fields.']);
  assert.strictEqual(C.appNameFrom('slack-members-2026-11-01.csv'), 'Slack');
  assert.strictEqual(C.appNameFrom('Users_Export.csv', 3), 'App 3');
  assert.strictEqual(C.appNameFrom('crm_users_export.csv'), 'CRM');
  assert.deepStrictEqual([C.appRole('false', '', 'Is Admin').text, C.appRole('false', '', 'Is Admin').level], ['', 'member'], 'a "no" under Is Admin is no role, not the word false');
  const r = C.appRole('Deactivated', '', 'Account type');
  assert.deepStrictEqual([r.off, r.level], [true, 'member']);
  assert.strictEqual(C.appRole('true', '', 'Is Admin').level, 'admin');
  assert.strictEqual(C.appRole('Master admin', 'Active', '').level, 'owner');
  assert.strictEqual(C.appRole('Bot', '', '').service, true);
});

/* ================================================================== *
 * Matching and verdicts
 * ================================================================== */

test('addresses: case, plus-addressing, the company\u2019s alias domains, mailto and Name <a@b>, Entra guest UPNs; names in any order, accents and titles folded', () => {
  const al = C.aliasMap(['acme.example', 'acme.co.example']);
  assert.strictEqual(C.normEmail('Ann.Lee' + AT + 'ACME.example', al).key, at('ann.lee'));
  const p = C.normEmail('ann.lee+files' + AT + 'acme.example', al);
  assert.deepStrictEqual([p.key, p.plus], [at('ann.lee'), true]);
  const a = C.normEmail('ann.lee' + AT + 'acme.co.example', al);
  assert.deepStrictEqual([a.key, a.alias], [at('ann.lee'), 'acme.co.example']);
  assert.strictEqual(C.normEmail('Ann Lee <ann.lee' + AT + 'acme.example>', al).key, at('ann.lee'));
  assert.strictEqual(C.normEmail('mailto:ann.lee' + AT + 'acme.example', al).key, at('ann.lee'));
  const g = C.normEmail('pat_ledger.example#EXT#' + AT + 'acme.onmicrosoft.example', al);
  assert.deepStrictEqual([g.key, g.guest], [at('pat', 'ledger.example'), true]);
  assert.strictEqual(C.normEmail('not an address', al), null);
  assert.strictEqual(C.nameKey('Reyes, Jordan'), C.nameKey('Dr. Jordan Reyes'));
  assert.strictEqual(C.nameKey('José Núñez'), C.nameKey('jose nunez'));
  assert.strictEqual(C.nameKey('Jordan'), '', 'one word is never enough to match on');
});

test('every verdict: orphan (deprovisioned, and not in the IdP at all), suspended, external, shared, dormant, already off, OK - and admins among orphans are critical and lead', () => {
  const idp = csv([['Email', 'Name', 'Status', 'Status changed', 'Last login'],
    [at('ann.lee'), 'Ann Lee', 'Active', '', '2026-11-02'], [at('bo.chen'), 'Bo Chen', 'Suspended', '2026-09-03', '2026-09-02'], [at('cy.diaz'), 'Cy Diaz', 'Deprovisioned', '2026-10-04', '2026-10-03'], [at('di.eko'), 'Di Eko', 'Active', '', '2026-11-01']]);
  const appA = csv([['Name', 'Email', 'Role', 'Last active'],
    ['Ann Lee', at('ann.lee'), 'Member', '2026-11-02'], ['Bo Chen', at('bo.chen'), 'Admin', '2026-09-01'], ['Cy Diaz', at('cy.diaz'), 'Member', '2026-10-02'], ['Ed Fox', at('ed.fox'), 'Owner', '2026-06-01'],
    ['Gil Hart', at('gil', 'outside.example'), 'Member', '2026-10-20'], ['Front Desk', at('reception'), 'Member', '2026-11-03'], ['Scanner', at('svc-scan'), 'Member', '2026-11-03'],
    ['Di Eko', at('di.eko'), 'Member', '2026-08-05'], ['Ann Lee', at('ann.lee', 'acme.co.example'), 'Deactivated', '2026-03-01']]);
  const r = analyse(idp, [{ text: appA, label: 'Files' }], { domains: ['acme.example', 'acme.co.example'], dormantDays: 90 });
  const rows = r.findings.concat(r.ok);
  const by = (n, v) => rows.filter((x) => x.name === n && (!v || x.verdict === v))[0];
  assert.deepStrictEqual(pick(rows), [
    'suspended! Files Bo Chen',
    'orphan! Files Ed Fox',
    'orphan Files Cy Diaz',
    'external Files Gil Hart',
    'shared Files Front Desk',
    'shared Files Scanner',
    'dormant Files Di Eko',
    'off Files Ann Lee',
    'ok Files Ann Lee',
  ], 'critical first, then by verdict');
  assert.match(by('Bo Chen').why, /^Suspended in the identity provider since Sep 3 \(61 days\) - still active here as Admin\.$/);
  assert.strictEqual(by('Bo Chen').leftDays, 61);
  assert.match(by('Cy Diaz').why, /^Deprovisioned in the identity provider since Oct 4 \(30 days\)/);
  assert.match(by('Ed Fox').why, /^No user in the identity provider with this address/);
  assert.match(by('Gil Hart').why, /Another domain \(outside\.example\)/);
  assert.match(by('Front Desk').sharedWhy, /reception/);
  assert.strictEqual(by('Scanner').sharedWhy, 'the address matches \u201csvc-*\u201d');
  assert.strictEqual(by('Di Eko').idleDays, 90);
  assert.ok(by('Ann Lee', 'off'), 'a deactivated account at the alias domain is already off');
  const s = r.summary;
  assert.deepStrictEqual([s.orphaned, s.apps, s.admins, s.oldest, s.counts.critical], [3, 1, 2, 61, 2]);
  assert.strictEqual(C.summaryLine(s), '3 orphaned accounts in 1 app · 2 are admins · oldest leaver: 61 days');
  assert.strictEqual(C.summaryLine(C.summarise([])), 'No orphaned accounts');
});

test('dormant maths with a fixed clock: the limit is inclusive, one day under is fine, never signed in counts, and a changed limit moves it', () => {
  const idp = csv([['Email', 'Name'], [at('ann.lee'), 'Ann Lee'], [at('bo.chen'), 'Bo Chen'], [at('cy.diaz'), 'Cy Diaz']]);
  const app = csv([['Email', 'Name', 'Last login'], [at('ann.lee'), 'Ann Lee', '2026-08-05'], [at('bo.chen'), 'Bo Chen', '2026-08-06'], [at('cy.diaz'), 'Cy Diaz', 'Never']]);
  const v = (dd, today) => { const r = analyse(idp, [{ text: app, label: 'Video' }], { dormantDays: dd }, today); return Object.fromEntries(r.findings.concat(r.ok).map((x) => [x.name, x.verdict + ':' + x.idleDays])); };
  assert.deepStrictEqual(v(90), { 'Ann Lee': 'dormant:90', 'Bo Chen': 'ok:89', 'Cy Diaz': 'dormant:null' }, 'no status column: everyone in the IdP is active');
  assert.deepStrictEqual(v(90, '2026-11-04'), { 'Ann Lee': 'dormant:91', 'Bo Chen': 'dormant:90', 'Cy Diaz': 'dormant:null' });
  assert.deepStrictEqual(v(120), { 'Ann Lee': 'ok:90', 'Bo Chen': 'ok:89', 'Cy Diaz': 'dormant:null' });
});

test('matching: by address first, then by name - flagged "matched by name - check" - but never when two people share the name; an IdP alias column counts', () => {
  const idp = csv([['Email', 'Other address', 'Name', 'Status'], [at('ann.lee'), at('al'), 'Ann Lee', 'Active'], [at('bo.chen'), '', 'Bo Chen', 'Suspended'], [at('kim.one'), '', 'Kim Park', 'Active'], [at('kim.two'), '', 'Kim Park', 'Active']]);
  const app = csv([['Name', 'Email'], ['Ann Lee', at('al')], ['Bo Chen', at('bchen', 'gmail.example')], ['Kim Park', at('kpark')], ['"Lee, Ann"', '']]);
  const r = analyse(idp, [{ text: app, label: 'Chat' }], { domains: ['acme.example'] });
  const rows = r.findings.concat(r.ok);
  const of = (e) => rows.filter((x) => x.email === e)[0];
  assert.deepStrictEqual([of(at('al')).verdict, of(at('al')).how], ['ok', 'matched by their other address']);
  assert.deepStrictEqual([of(at('bchen', 'gmail.example')).verdict, of(at('bchen', 'gmail.example')).how, of(at('bchen', 'gmail.example')).byName], ['suspended', 'matched by name - check', true], 'a personal address found by name, still suspended');
  assert.strictEqual(of(at('kpark')).verdict, 'orphan', 'two Kim Parks: no guess');
  assert.deepStrictEqual([of('').verdict, of('').how], ['ok', 'matched by name - check'], 'a row with only a name');
});

test('the per-person view: one line per person, leavers first, every live account and the ones already off', () => {
  const r = demo(TODAY);
  assert.deepStrictEqual(r.people.map((p) => p.line), [
    'Jordan Reyes: suspended in Okta since Aug 1 - still active in Accounting (admin), File share, Video meetings · already off in Team chat',
    'Wren Halvorsen: deprovisioned in Okta since Sep 23 - still active in File share (admin), Team chat, Video meetings',
    'Casey Morgan: not in Okta - still active in Team chat',
    'Pat Delgado: not in Okta - outside account in Accounting',
    'Marcus Bell: active in Okta - dormant in Video meetings',
  ]);
  assert.deepStrictEqual(r.people.map((p) => p.group), ['leaver', 'leaver', 'leaver', 'external', 'dormant']);
  assert.deepStrictEqual(r.people.map((p) => p.critical), [true, true, false, false, false]);
});

/* ================================================================== *
 * The demo, on any day
 * ================================================================== */

test('the demo: exactly the intended findings - a hygienist suspended 94 days still an admin in Accounting (critical), the temp, reception@, the outside accountant, the dormant licence - on every 7th day for a year', () => {
  for (let d = 0; d < 365; d += 7) {
    const day = C.addDays(TODAY, d);
    const r = demo(day);
    assert.strictEqual(C.summaryLine(r.summary), '7 orphaned accounts in 4 apps · 2 are admins · oldest leaver: 94 days', day);
    assert.deepStrictEqual(pick(r.findings), [
      'suspended! Accounting Jordan Reyes',
      'orphan! File share Wren Halvorsen',
      'suspended File share Jordan Reyes',
      'suspended Video meetings Jordan Reyes',
      'orphan Team chat Wren Halvorsen',
      'orphan Video meetings Wren Halvorsen',
      'orphan Team chat Casey Morgan',
      'external Accounting Pat Delgado',
      'shared Team chat Front Desk',
      'shared File share Reception',
      'shared File share Scanner',
      'dormant Video meetings Marcus Bell',
      'off Team chat Jordan Reyes',
    ], day);
    assert.deepStrictEqual([r.okTotal, r.users, r.findings.length + r.okTotal], [32, 16, 45], day);
    const how = Object.fromEntries(r.ok.filter((x) => x.how).map((x) => [`${x.name} ${x.appName}`, x.how]));
    assert.deepStrictEqual(how, { 'Dana Whitlock File share': 'matched the +tag ignored', 'Felix Brandt Accounting': 'matched by name - check', 'Hana Sato Team chat': 'matched through the alias harborpinedental.example' }, day);
  }
  const r = demo(TODAY);
  assert.strictEqual(r.findings[0].why, 'Suspended in Okta since Aug 1 (94 days) - still active here as Company admin.');
  assert.strictEqual(r.pi.idp, 'okta');
});

test('the demo\u2019s leaver email reads into Sam Okafor, last day Friday, keep the mailbox for the office manager - with the words each came from - and two questions', () => {
  const p = C.parseRequest(D.request(), { today: TODAY, time: '10:00', names: demo(TODAY).names });
  const v = (k) => p.fields[k] && p.fields[k].value;
  assert.deepStrictEqual([v('name'), v('email'), v('lastDay'), v('involuntary'), v('mailbox'), v('mailTo'), v('filesTo'), v('requestedBy')], ['Sam Okafor', at('sam.okafor', 'harborpine.example'), '2026-11-06', false, 'shared', 'the office manager (Dana Whitlock)', 'Hana Sato', 'Dana Whitlock']);
  assert.deepStrictEqual(v('hardware'), ['laptop', 'key fob']);
  assert.deepStrictEqual([p.fields.lastDay.from, p.fields.name.from, p.fields.involuntary.from, p.fields.filesTo.from], ['last day is Friday', 'Sam Okafor\u2019s last day', 'moving on', 'give their files to Hana Sato']);
  for (const k of Object.keys(p.fields).filter((x) => x !== 'hardware')) assert.ok(C.fold(p.text).replace(/\s+/g, ' ').includes(C.fold(p.fields[k].from).replace(/\s+/g, ' ')), `${k}: its source words are in the request`);
  assert.deepStrictEqual(p.questions.map((q) => q.text), ['What time should their access end on Fri Nov 6?', 'Who is their manager?']);
  // Friday, from every day of a week.
  const fri = { '2026-11-02': '2026-11-06', '2026-11-05': '2026-11-06', '2026-11-06': '2026-11-06', '2026-11-07': '2026-11-13', '2026-11-08': '2026-11-13' };
  for (const [day, want] of Object.entries(fri)) assert.strictEqual(C.parseRequest(D.request(), { today: day }).fields.lastDay.value, want, day);
});

test('the demo\u2019s checklist for Sam: 29 steps from the practice\u2019s systems, the three apps they were found in pre-filled, Accounting marked "not in the export", times from the last day', () => {
  const r = demo(TODAY);
  const lv = C.leaverFrom(C.parseRequest(D.request(), { today: TODAY }));
  const found = r.engine.lookup({ ws: 'demo', email: lv.email, name: lv.name });
  assert.deepStrictEqual(found.map((x) => x.appName).sort(), ['File share', 'Team chat', 'Video meetings']);
  const inv = C.cleanInventory(D.inventory()).inventory;
  const tasks = C.buildChecklist(lv, inv, found, r.apps.map((a) => a.name));
  assert.strictEqual(tasks.length, 29);
  const count = (ph) => tasks.filter((t) => t.phase === ph).length;
  assert.deepStrictEqual(C.PHASES.map(count), [4, 14, 6, 5]);
  const t = (id) => tasks.find((x) => x.id === id);
  assert.deepStrictEqual(t('g-confirm').due, { day: '2026-11-05', time: '' }, 'before the last day: the working day before');
  assert.deepStrictEqual(t('disable:chat').due, { day: '2026-11-06', time: '17:00' }, 'no time given: the end of the day');
  assert.deepStrictEqual(t('mailbox:email').due, { day: '2026-11-07', time: '17:00' });
  assert.deepStrictEqual(t('licence:files').due, { day: '2026-12-06', time: '' });
  assert.strictEqual(t('mailbox:email').detail, 'Convert to a shared mailbox and give the office manager (Dana Whitlock) access.');
  assert.strictEqual(t('files:files').detail, 'Give ownership to Hana Sato.');
  assert.match(t('disable:files').found, /^Found in the File share export: sam\.okafor.* as Member - last active Nov 2\.$/);
  assert.match(t('disable:accounting').notFound, /^Not in the Accounting export you loaded/);
  assert.strictEqual(t('disable:records').notFound, '', 'no export for the records system: nothing claimed');
  assert.strictEqual(tasks.filter((x) => x.id === 'g-collect').length, 0, 'the laptops-and-phones system collects the hardware');
  assert.strictEqual(t('hardware:devices').detail, 'laptop, key fob.');
  assert.deepStrictEqual(tasks.slice(4, 9).map((x) => x.id), ['disable:idp', 'sessions:idp', 'mfa:idp', 'sessions:email', 'tokens:email'], 'each system\u2019s steps together, in the inventory\u2019s order');
});

/* ================================================================== *
 * The checklist
 * ================================================================== */

test('the checklist: voluntary and involuntary timing, admin roles handed over first, an app missing from the inventory added, progress and overdue against a fixed clock, ticks kept through a rebuild', () => {
  const inv = { systems: [{ id: 'mail', name: 'Email', sso: true, steps: ['sessions', 'mailbox', 'licence'], owner: 'msp' }, { id: 'files', name: 'Files', sso: false, steps: ['files', 'disable'], owner: 'office' }, { id: 'door', name: 'Door', sso: false, steps: ['rotate'], owner: 'office' }] };
  const found = [{ appName: 'Files', email: at('bo'), role: 'Team admin', level: 'admin', verdict: 'ok', lastActive: '2026-10-30' }, { appName: 'Payroll', email: at('bo'), role: 'Member', level: 'member', verdict: 'ok', lastActive: null }];
  const vol = C.cleanLeaver({ name: 'Bo Chen', email: at('bo'), lastDay: '2026-11-09', involuntary: false, filesTo: 'Ann Lee', mailbox: 'forward', mailTo: 'Ann Lee' });
  const inv1 = Object.assign({}, vol, { involuntary: true, lastTime: '14:30' });
  const a = C.buildChecklist(vol, inv, found), b = C.buildChecklist(inv1, inv, found);
  const ph = (list, id) => list.find((t) => t.id === id).phase;
  assert.deepStrictEqual(['files:files', 'admin:files', 'rotate:door', 'disable:files'].map((id) => ph(a, id)), ['before', 'before', 'day1', 'moment'], 'voluntary: hand over files and admin roles before, rotate codes the day after');
  assert.deepStrictEqual(['files:files', 'admin:files', 'rotate:door', 'disable:files'].map((id) => ph(b, id)), ['day1', 'moment', 'moment', 'moment'], 'involuntary: everything at the moment of notice, files the day after');
  assert.ok(b.find((t) => t.id === 'g-schedule') && !b.find((t) => t.id === 'g-confirm') && !b.find((t) => t.id === 'g-shared'));
  assert.deepStrictEqual(b.find((t) => t.id === 'disable:files').due, { day: '2026-11-09', time: '14:30' });
  assert.deepStrictEqual(a.find((t) => t.id === 'g-confirm').due, { day: '2026-11-06', time: '' }, 'a Monday last day: "before" is the Friday');
  assert.strictEqual(C.phaseWord('moment', true), 'At the moment of notice');
  const pay = a.filter((t) => t.system === 'Payroll');
  assert.deepStrictEqual(pay.map((t) => t.key), ['disable', 'sessions', 'licence']);
  assert.ok(pay.every((t) => t.added && /Found in the Payroll export/.test(t.found)));
  assert.strictEqual(a.find((t) => t.id === 'mailbox:mail').detail, 'Forward their mail to Ann Lee.');
  assert.strictEqual(a.find((t) => t.id === 'disable:files').detail, 'Not on single sign-on - the identity provider does not reach this account.');
  assert.strictEqual(a.find((t) => t.id === 'sessions:mail').detail, 'Suspending them in the identity provider does not end sessions already open here.');
  // progress against a fixed clock
  const now = { day: '2026-11-09', time: '18:00' };
  let p = C.progress(a, now);
  assert.deepStrictEqual([p.total, p.done, p.open, p.overdue], [a.length, 0, a.length, a.filter((t) => t.phase === 'before' || t.phase === 'moment').length]);
  a.filter((t) => t.phase === 'before').forEach((t) => { t.done = true; t.by = 'SO'; t.at = '2026-11-05T10:12'; t.evidence = 'ticket 4821'; });
  p = C.progress(a, now);
  assert.deepStrictEqual([p.done, p.evidence, p.overdue, p.pct], [a.filter((t) => t.phase === 'before').length, a.filter((t) => t.phase === 'before').length, a.filter((t) => t.phase === 'moment').length, Math.round(p.done / p.total * 100)]);
  // a rebuild after the last day changes keeps every tick, by id
  const moved = C.mergeTasks(a, C.buildChecklist(Object.assign({}, vol, { lastDay: '2026-11-13' }), inv, found));
  assert.deepStrictEqual(moved.filter((t) => t.done).map((t) => [t.id, t.by, t.evidence]), a.filter((t) => t.done).map((t) => [t.id, 'SO', 'ticket 4821']));
  assert.strictEqual(moved.find((t) => t.id === 'disable:files').due.day, '2026-11-13');
  // no last day: nothing is dated, nothing is overdue
  const nod = C.buildChecklist(C.cleanLeaver({ name: 'X Y' }), inv, []);
  assert.ok(nod.every((t) => t.due === null) && C.progress(nod, now).overdue === 0);
});

/* ================================================================== *
 * The request reader
 * ================================================================== */

const P = (text, extra) => C.parseRequest(text, Object.assign({ today: TODAY, time: '10:15' }, extra || {}));
const val = (text, k, extra) => { const f = P(text, extra).fields[k]; return f ? f.value : undefined; };

test('the reader finds the leaver\u2019s name every common way, widens a first name, and never takes a greeting or a weekday for one', () => {
  assert.strictEqual(val('Hi all, Jordan Reyes is leaving us at the end of the month.', 'name'), 'Jordan Reyes');
  assert.strictEqual(val('Please offboard Casey Morgan today.', 'name'), 'Casey Morgan');
  assert.strictEqual(val('Subject: Leaver - Wren Halvorsen\n\nsee below', 'name'), 'Wren Halvorsen');
  assert.strictEqual(val('Employee: Ada Mensah\nLast day: 11/14', 'name'), 'Ada Mensah');
  assert.strictEqual(val('Last day for Marcus Bell is Friday.', 'name'), 'Marcus Bell');
  assert.strictEqual(val('Sam\u2019s last day is Friday. Sam Okafor has the laptop.', 'name'), 'Sam Okafor');
  const k = P('Sam\u2019s last day is Friday.', { names: ['Sam Okafor', 'Dana Whitlock'] }).fields.name;
  assert.deepStrictEqual([k.value, k.note], ['Sam Okafor', 'the full name is from your identity provider\u2019s export']);
  assert.strictEqual(val('Thanks\nFriday is fine', 'name'), undefined);
  assert.strictEqual(val('Ines Carvalho has resigned.', 'name'), 'Ines Carvalho');
});

test('the reader resolves dates against today in the browser\u2019s zone, with a note where it chose: weekdays, this/next, tomorrow, end of the month, 11/14 and 14/11, month names, "the 14th", "in two weeks", now', () => {
  const d = (s, extra) => { const f = P(s, extra).fields.lastDay; return f ? [f.value, f.note] : null; };
  assert.deepStrictEqual(d('Their last day is Friday.'), ['2026-11-06', '']);
  assert.deepStrictEqual(d('Their last day is this Friday.'), ['2026-11-06', '']);
  assert.deepStrictEqual(d('Their last day is next Friday.'), ['2026-11-13', '\u201cnext Friday\u201d read as Fri Nov 13 - check']);
  assert.deepStrictEqual(d('Their last day is Tuesday.'), ['2026-11-03', 'Tuesday read as today - check']);
  assert.deepStrictEqual(d('Last day tomorrow please.'), ['2026-11-04', '']);
  assert.deepStrictEqual(d('Their last day is the end of the month.'), ['2026-11-30', 'end of the month: Mon Nov 30']);
  assert.deepStrictEqual(d('Leaving at the end of next week.'), ['2026-11-13', 'end of next week read as the Friday after this one']);
  assert.deepStrictEqual(d('Last day 11/14.'), ['2026-11-14', ''], 'a 14 can only be a day');
  assert.deepStrictEqual(d('Last day 11/14.', { dayFirst: true }), ['2026-11-14', '']);
  assert.deepStrictEqual(d('Last day 11/12.'), ['2026-11-12', 'read month first - check']);
  assert.deepStrictEqual(d('Last day 14/11/2026.'), ['2026-11-14', '']);
  assert.deepStrictEqual(d('Last day 12/11.', { dayFirst: true }), ['2026-11-12', 'read day first - check']);
  assert.deepStrictEqual(d('Last day is November 14th.'), ['2026-11-14', '']);
  assert.deepStrictEqual(d('Last day is the 14th of November.'), ['2026-11-14', '']);
  assert.deepStrictEqual(d('Last day is Jan 8.'), ['2027-01-08', ''], 'a date far in the past is next year');
  assert.deepStrictEqual(d('Their last day will be the 14th.'), ['2026-11-14', 'the 14th read as this month']);
  assert.deepStrictEqual(d('Their last day will be the 2nd.'), ['2026-12-02', 'the 2nd read as next month']);
  assert.deepStrictEqual(d('Resigned, last day in two weeks.'), ['2026-11-17', 'in two weeks from today']);
  assert.deepStrictEqual(d('Leaving on Friday, the 13th.'), ['2026-11-13', '']);
  assert.deepStrictEqual(d('Last day 2026-12-01.'), ['2026-12-01', '']);
  const now = P('Terminated, effective immediately.');
  assert.deepStrictEqual([now.fields.lastDay.value, now.fields.lastTime.value, now.fields.involuntary.value], ['2026-11-03', '10:15', true]);
  assert.deepStrictEqual(d('Thanks. Leaving 11/20, see you.'), ['2026-11-20', '']);
  assert.deepStrictEqual(d('See you 11/20.'), ['2026-11-20', 'the only date in the request']);
});

test('the reader: times, voluntary or not, the mailbox, files, the manager, hardware - and "me" is the sender', () => {
  assert.deepStrictEqual([val('Last day Friday at 3pm.', 'lastTime'), val('Last day Friday, 17:30.', 'lastTime')], ['15:00', '17:30']);
  const eod = P('Last day Friday end of day.').fields.lastTime;
  assert.deepStrictEqual([eod.value, eod.note], ['17:00', '\u201cend of day\u201d read as 5:00 PM']);
  assert.strictEqual(val('Last day is Friday at noon.', 'lastTime'), '12:00');
  assert.strictEqual(val('Bo has been let go.', 'involuntary'), true);
  assert.strictEqual(val('This is a termination for cause.', 'involuntary'), true);
  assert.strictEqual(val('Bo handed in their notice and is retiring.', 'involuntary'), false);
  const both = P('Bo resigned but HR says terminate effective immediately.').fields.involuntary;
  assert.deepStrictEqual([both.value, /also says/.test(both.note)], [true, true]);
  assert.strictEqual(val('No word on how they are leaving.', 'involuntary'), undefined);
  assert.deepStrictEqual([val('Please forward their email to Ruby Castellano.', 'mailbox'), val('Please forward their email to Ruby Castellano.', 'mailTo')], ['forward', 'Ruby Castellano']);
  assert.deepStrictEqual([val('Convert the mailbox to a shared mailbox for the front desk.', 'mailbox'), val('Convert the mailbox to a shared mailbox for the front desk.', 'mailTo')], ['shared', 'the front desk']);
  assert.strictEqual(val('Delete their mailbox after 30 days.', 'mailbox'), 'delete');
  assert.deepStrictEqual([val('Give Hana access to their inbox.', 'mailTo'), val('Give Hana access to their inbox.', 'mailbox')], ['Hana', 'shared']);
  assert.strictEqual(val('Transfer their OneDrive to Ada Mensah please', 'filesTo'), 'Ada Mensah');
  assert.strictEqual(val('Their files should go to the practice owner.', 'filesTo'), 'the practice owner');
  assert.strictEqual(val('Their manager is Theo Abernathy.', 'manager'), 'Theo Abernathy');
  assert.strictEqual(val('Reports to Maya Lindqvist.', 'manager'), 'Maya Lindqvist');
  assert.deepStrictEqual(val('Collect the laptop, their badge, the company card and the keys.', 'hardware'), ['laptop', 'keys', 'badge', 'company card']);
  assert.strictEqual(val('Call me on my phone number 555-0100.', 'hardware'), undefined, '"phone number" is not hardware');
  const me = P('From: Dana Whitlock <dana' + AT + 'acme.example>\n\nForward their mail to me.').fields.mailTo;
  assert.deepStrictEqual([me.value, me.note], ['Dana Whitlock', '\u201cme\u201d is the sender']);
  const q = P('Something is up with Bo.').questions.map((x) => x.field);
  assert.deepStrictEqual(q, ['name', 'email', 'lastDay', 'lastTime', 'involuntary', 'filesTo', 'mailbox', 'manager'], 'no mailbox answer: one mail question, not two');
  const lv = C.leaverFrom(P(D.request()));
  assert.deepStrictEqual([lv.name, lv.mailbox, lv.from.lastDay], ['Sam Okafor', 'shared', 'last day is Friday']);
});

/* ================================================================== *
 * Masking and the AI's request and answer
 * ================================================================== */

test('masking: every address, phone, link, long number and named person becomes a token, a first name standing alone is the same person, tokens are never masked inside - and unmasking gives the text back', () => {
  const text = 'From: Dana Whitlock <' + at('dana') + '>\nSam Okafor\u2019s last day is Friday. Sam has the laptop. Mail ' + at('sam.okafor') + ' or call (207) 555-0143 / 555-0199. Ticket 48213377, see https://help.acme.example/t/1 and acme.example. Employee id 219 09 9999. Ask Jojo.';
  const m = C.maskRequest(text, ['Sam Okafor', 'Dana Whitlock'], ['Jojo']);
  assert.strictEqual(m.text, 'From: [person1] <[email1]>\n[person2]\u2019s last day is Friday. [person2] has the laptop. Mail [email2] or call [phone1] / [phone2]. Ticket [number1], see [link1] and [link2]. Employee id [number2]. Ask [word1].');
  assert.deepStrictEqual(m.counts, { email: 2, phone: 2, person: 2, link: 2, number: 2, word: 1 });
  assert.strictEqual(C.unmask(m.text, m.map), text.replace('Sam has', 'Sam Okafor has'), 'round trip (a first name comes back as the full name)');
  assert.strictEqual(C.unmask('[person2] and [person9]', m.map), 'Sam Okafor and [person9]', 'an unknown token stays a token');
  assert.ok(!/\S@\S/.test(m.text) && C.aiRequest({ text: m.text, today: TODAY }).req, 'the masked text passes the server\u2019s check');
  const named = C.maskRequest('Link Person met [person1].', ['Link Person']);
  assert.strictEqual(named.text, '[person1] met [person1].'.replace(/^\[person1\]/, '[person1]'), 'a name that looks like a token word is still masked');
  const long = C.maskRequest('x'.repeat(5000), []);
  assert.deepStrictEqual([long.cut, long.text.length <= C.LIMITS.aiChars], [true, true]);
});

test('the AI request: masked text and today only; an address or a long run of digits refused with a code; dates and times allowed; tokens listed', () => {
  assert.strictEqual(C.aiRequest({ text: 'hello', today: TODAY, extra: 1 }).error, 'Send only the masked text and today\u2019s date.');
  assert.strictEqual(C.aiRequest({ text: '', today: TODAY }).error, 'Paste the request first.');
  assert.match(C.aiRequest({ text: 'x', today: 'friday' }).error, /today/);
  assert.match(C.aiRequest({ text: 'x'.repeat(4001), today: TODAY }).error, /longer than/);
  assert.strictEqual(C.aiRequest({ text: 'mail ' + at('sam'), today: TODAY }).code, 'unmasked-email');
  assert.strictEqual(C.aiRequest({ text: 'mail sam' + AT + 'acme', today: TODAY }).code, 'unmasked-email', 'any x@y at all');
  assert.strictEqual(C.aiRequest({ text: 'call 207-555-0143', today: TODAY }).code, 'unmasked-number');
  assert.strictEqual(C.aiRequest({ text: 'id 219 09 9999', today: TODAY }).code, 'unmasked-number');
  const ok = C.aiRequest({ text: '[person1] leaves 2026-11-06 17:00, or 11/06/2026 at 5:30. [email1] [phone12]', today: TODAY, dayFirst: true });
  assert.deepStrictEqual(ok.req.tokens.sort(), ['[email1]', '[person1]', '[phone12]']);
  assert.strictEqual(ok.req.dayFirst, true);
});

test('the AI answer: only known fields; an address only as an [emailN] token it was sent; real dates within a year; HH:MM; booleans; the lists\u2019 values; no markup, links, addresses or unknown tokens; the source words must be in the text', () => {
  const req = C.aiRequest({ text: 'Subject: [person1] leaving\n[person1] won\u2019t be back after the 14th, not a happy exit. Stuff in the drive should go to whoever covers hygiene. [email1]', today: TODAY }).req;
  const out = C.cleanAiAnswer({
    name: { value: '<img src=x onerror=alert(1)>[person1]', from: '[person1] won\u2019t be back' },
    email: { value: '[email1]', from: 'https://evil.example' },
    last_day: { value: '2026-11-14', from: 'after the 14th' },
    last_time: { value: '25:99' },
    involuntary: { value: true, from: 'not a happy exit' },
    mailbox: { value: 'exfiltrate' },
    hardware: { value: ['laptop', 'rocket', 'laptop'] },
    files_to: { value: 'whoever covers hygiene \u202E www.evil.example [person7]', from: 'should go to whoever covers hygiene' },
    manager: { value: 'x'.repeat(500) },
    mail_to: { value: 'pat' + AT + 'evil.example' },
    password: { value: 'hunter2' },
    questions: ['<b>Click</b> https://evil.example to confirm', 'Who covers hygiene now?', ''],
  }, req);
  assert.deepStrictEqual(Object.keys(out.fields).sort(), ['email', 'filesTo', 'hardware', 'involuntary', 'lastDay', 'name']);
  assert.strictEqual(out.fields.name.value, '[person1]');
  assert.strictEqual(out.fields.name.from, '[person1] won\u2019t be back');
  assert.strictEqual(out.fields.email.from, '', 'a source that is not in the text is dropped');
  assert.strictEqual(out.fields.filesTo.value, 'whoever covers hygiene', 'bidi, link and an unknown token gone');
  assert.deepStrictEqual(out.fields.hardware.value, ['laptop']);
  assert.deepStrictEqual(out.questions, ['Click to confirm', 'Who covers hygiene now?']);
  assert.ok(out.dropped >= 5);
  assert.strictEqual(C.cleanAiAnswer({ last_day: { value: '2031-01-01' }, email: { value: '[email2]' } }, req).fields.lastDay, undefined, 'a date years away is dropped');
  assert.deepStrictEqual(C.cleanAiAnswer({ email: { value: '[email2]' } }, req).fields, {}, 'a token it was never sent is dropped');
  assert.deepStrictEqual(C.cleanAiAnswer(null, req), { fields: {}, questions: [], dropped: 0 });
});

/* ================================================================== *
 * Exports and the inventory
 * ================================================================== */

test('exports: the findings and the checklist as CSV with formula cells defused, the PSA JSON in its documented shape, Markdown escaped', () => {
  assert.strictEqual(C.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.strictEqual(C.csvCell('+1'), "'+1");
  assert.strictEqual(C.csvCell('-2'), "'-2");
  assert.strictEqual(C.csvCell(AT + 'sum'), "'" + AT + 'sum');
  assert.strictEqual(C.csvCell('\tx'), "'\tx");
  assert.strictEqual(C.csvCell('a,b'), '"a,b"');
  const r = demo(TODAY);
  const rows = C.findingsRows(r.findings.concat(r.ok), 'okta');
  assert.deepStrictEqual(rows[0], ['app', 'account', 'name', 'verdict', 'critical', 'role', 'last_active', 'idp_status', 'idp_status_changed', 'days_since_left', 'days_idle', 'matched', 'why']);
  assert.deepStrictEqual(rows[1].slice(0, 5), ['Accounting', at('jordan.reyes', 'harborpine.example'), 'Jordan Reyes', 'Suspended in Okta, active here', 'yes']);
  assert.strictEqual(rows.length, 46);
  const lv = C.leaverFrom(C.parseRequest(D.request(), { today: TODAY }));
  lv.name = '=cmd|calc';
  lv.tasks = C.buildChecklist(lv, C.cleanInventory(D.inventory()).inventory, []);
  lv.tasks[0].done = true; lv.tasks[0].by = 'SO'; lv.tasks[0].at = '2026-11-03T10:12'; lv.tasks[0].evidence = '+screenshot in ticket 4821 *bold* [link](x)';
  const out = C.toCsv(C.checklistRows(lv));
  assert.ok(out.startsWith('leaver,leaver_email,phase,due,system,step,detail,owner,status,done_by,done_at,evidence\r\n'));
  assert.ok(out.includes("'=cmd|calc") && out.includes("'+screenshot in ticket 4821") && !/(^|,)=cmd/m.test(out));
  const j = C.checklistJson(lv, { day: TODAY, time: '10:20' });
  assert.deepStrictEqual(Object.keys(j), ['format', 'generated', 'leaver', 'progress', 'tasks']);
  assert.strictEqual(j.format, 'lastday.checklist.v1');
  assert.deepStrictEqual(Object.keys(j.leaver), ['name', 'email', 'lastDay', 'lastTime', 'involuntary', 'manager', 'filesTo', 'mailTo', 'mailbox', 'hardware']);
  assert.deepStrictEqual(Object.keys(j.tasks[0]), ['id', 'phase', 'phaseLabel', 'due', 'system', 'sso', 'action', 'title', 'detail', 'foundInExport', 'owner', 'ownerLabel', 'status', 'doneBy', 'doneAt', 'evidence']);
  assert.deepStrictEqual([j.tasks[0].status, j.tasks[0].doneBy, j.tasks[1].status, j.progress.done], ['done', 'SO', 'open', 1]);
  assert.strictEqual(j.tasks.find((t) => t.id === 'disable:chat').due, '2026-11-06T17:00');
  const md = C.checklistMarkdown(lv, { day: TODAY, time: '10:20' });
  assert.ok(md.startsWith('## Leaver: =cmd\\|calc\n'));
  assert.ok(md.includes('- [x] Confirm the last day and when access ends - Their manager (SO, 2026-11-03 10:12) - evidence: +screenshot in ticket 4821 \\*bold\\* \\[link\\](x)'));
  assert.ok(md.includes('### At the moment they leave (by 2026-11-06 17:00)'));
  assert.ok(md.includes('- [ ] **Team chat:** Disable or remove the account - MSP / IT provider'));
});

test('the inventory: strict cleaning refuses people (addresses, first.last patterns, unknown fields like users or a checklist), roles off the list and oversize lists; merge keeps both sides\u2019 systems', () => {
  const good = D.inventory();
  assert.deepStrictEqual(C.cleanInventory(good, true).errors, []);
  const bad = (mut) => { const x = JSON.parse(JSON.stringify(good)); mut(x); return C.cleanInventory(x, true).errors; };
  assert.match(bad((x) => { x.users = [{ email: at('a') }]; })[0], /not part of a system list/);
  assert.match(bad((x) => { x.leavers = []; })[0], /not part of a system list/);
  assert.match(bad((x) => { x.systems[0].people = ['Sam Okafor']; })[0], /is not kept/);
  assert.match(bad((x) => { x.systems[0].name = at('sam.okafor'); })[0], /looks like a person/);
  assert.match(bad((x) => { x.systems[0].owner = 'Dana Whitlock'; })[0], /role from the list, never a person/);
  assert.match(bad((x) => { x.systems[0].steps.push('exfiltrate'); })[0], /is not a step/);
  assert.match(bad((x) => { x.systems[0].sso = 'yes'; })[0], /yes or no/);
  assert.match(bad((x) => { x.settings.domains.push(at('sam')); })[0], /is an address/);
  assert.match(bad((x) => { x.settings.domains.push('not a domain'); })[0], /is not a domain/);
  assert.match(bad((x) => { x.settings.patterns = ['sam.okafor']; })[0], /looks like a person/);
  assert.match(bad((x) => { x.settings.patterns = ['*']; })[0], /is not a pattern/);
  assert.match(bad((x) => { x.settings.dormantDays = 3; })[0], /14 to 730 days/);
  assert.match(bad((x) => { x.settings.email = at('a'); })[0], /is not a setting/);
  assert.match(bad((x) => { x.systems = Array.from({ length: 61 }, (_, i) => ({ name: 'S' + i, steps: [], owner: 'it' })); })[0], /At most 60 systems/);
  assert.match(bad((x) => { x.systems.push({ name: 'team CHAT', steps: [], owner: 'it' }); })[0], /Two systems are called/);
  const lenient = C.cleanInventory({ systems: [{ name: at('x'), steps: ['disable'] }, { name: 'Ok', steps: ['nope', 'disable', 'disable'], owner: 'boss' }], settings: { patterns: ['a.b', 'svc-*'] } }).inventory;
  assert.deepStrictEqual([lenient.systems.length, lenient.systems[0].steps, lenient.systems[0].owner, lenient.settings.patterns], [1, ['disable'], 'it', ['svc-*']], 'not strict: bad entries dropped');
  const a = C.cleanInventory({ systems: [{ name: 'Payroll', steps: ['disable'], owner: 'finance' }, { name: 'Team chat', sso: false, steps: [], owner: 'it' }], settings: { domains: ['other.example'], dormantDays: 60 } }).inventory;
  const m = C.mergeInventory(a, good);
  assert.strictEqual(m.added, 1);
  assert.ok(m.inventory.systems.find((s) => s.name === 'Payroll'));
  assert.strictEqual(m.inventory.systems.find((s) => s.name === 'Team chat').sso, true, 'this device wins a name both have');
  assert.deepStrictEqual([m.inventory.settings.domains, m.inventory.settings.dormantDays], [['harborpine.example', 'harborpinedental.example', 'other.example'], 90]);
  assert.ok(C.patternFits('svc-*', 'svc-scanner') && C.patternFits('reception', 'front.reception') && !C.patternFits('it', 'it.support') && C.patternFits('it', 'it') && !C.patternFits('team', 'teamwork'));
});

/* ================================================================== *
 * Hostile files
 * ================================================================== */

test('hostile files: 60,000 rows capped and counted, a 2 MB cell cut, 90 columns, bidi and zero-width characters removed, markup and formulas kept as plain text, a CSV of nothing but quotes', () => {
  const big = 'Email,Name\n' + Array.from({ length: 60000 }, (_, i) => `u${i}${AT}acme.example,User ${i}`).join('\n');
  const t0 = Date.now();
  const r = analyse(big, [{ text: 'Email,Name\n' + at('u1') + ',User 1\n' + at('ghost') + ',Gho St\n', label: 'X' }]);
  assert.ok(Date.now() - t0 < 8000, `60,000 rows in ${Date.now() - t0} ms`);
  assert.deepStrictEqual([r.pi.stats.kept, r.pi.stats.truncated, r.users], [50000, 10000, 50000]);
  const cellT = C.parseTable('Email,Name\n' + at('a') + ',"' + 'x'.repeat(2 * 1024 * 1024) + '"\n');
  assert.deepStrictEqual([cellT.rows[0][1].length, cellT.cut], [C.LIMITS.cell, 1]);
  const wide = C.parseTable(Array.from({ length: 90 }, (_, i) => 'c' + i).join(',') + '\n' + Array.from({ length: 90 }, () => 'v').join(','));
  assert.deepStrictEqual([wide.headers.length, wide.wide], [80, 10]);
  const evil = 'Email,Name,Role\n' + at('jo') + ',"Jo\u202Edranoe\u200B <img src=x onerror=alert(1)>",=HYPERLINK("http://evil.example")\n';
  const e = C.parseTable(evil);
  assert.deepStrictEqual([e.rows[0][1], e.invisible], ['Jodranoe <img src=x onerror=alert(1)>', 2], 'bidi and zero-width removed and counted; markup stays text (escaped when drawn)');
  assert.strictEqual(e.rows[0][2], '=HYPERLINK("http://evil.example")');
  assert.strictEqual(C.esc(e.rows[0][1]), 'Jodranoe &lt;img src=x onerror=alert(1)&gt;');
  assert.doesNotThrow(() => C.parseTable('"""""""""""",,,,""\n\n\n"'));
  assert.doesNotThrow(() => C.parseRequest('<script>' + 'a '.repeat(10000), { today: TODAY }));
  const t1 = Date.now();
  C.parseRequest(('Friday ' + 'Leaving: X '.repeat(5) + '11/12 ').repeat(800), { today: TODAY });
  C.maskRequest(('Sam Okafor ' + at('a') + ' 555-0100 ').repeat(300), ['Sam Okafor']);
  assert.ok(Date.now() - t1 < 4000, `hostile requests read in ${Date.now() - t1} ms`);
});

/* ================================================================== *
 * The worker, in a real worker thread
 * ================================================================== */

function spawnWorker() {
  const w = new Worker(`
    const { parentPort } = require('worker_threads'); const fs = require('fs'); const vm = require('vm'); const path = require('path');
    const dir = ${JSON.stringify(PUB)};
    global.self = global; global.module = undefined; global.exports = undefined;
    global.importScripts = (...f) => f.forEach((x) => vm.runInThisContext(fs.readFileSync(path.join(dir, x), 'utf8'), { filename: x }));
    global.postMessage = (m) => parentPort.postMessage(m);
    global.addEventListener = (t, fn) => { if (t === 'message') parentPort.on('message', (data) => fn({ data })); };
    vm.runInThisContext(fs.readFileSync(path.join(dir, 'lastday-worker.js'), 'utf8'), { filename: 'lastday-worker.js' });
  `, { eval: true });
  let seq = 0;
  const waits = {};
  w.on('message', (m) => { const p = waits[m.id]; if (!p) return; delete waits[m.id]; if (m.ok) p.resolve(m.out); else p.reject(new Error(m.error)); });
  return { call: (op, data) => new Promise((resolve, reject) => { const id = ++seq; waits[id] = { resolve, reject }; w.postMessage({ id, op, data }); }), stop: () => w.terminate() };
}

test('the worker reads a File itself, guesses, analyses and looks a leaver up with the same engine; a file over 20 MB is refused before it is read', async () => {
  const w = spawnWorker();
  try {
    const ex = D.exportsFor(TODAY);
    const idp = await w.call('parse', { id: 'i', role: 'idp', file: new File([ex.idp.text], ex.idp.name), name: ex.idp.name });
    assert.deepStrictEqual([idp.idp, idp.stats.kept, idp.name], ['okta', 16, ex.idp.name]);
    const apps = [];
    for (const [i, a] of ex.apps.entries()) { const p = await w.call('parse', { id: 'a' + i, role: 'app', text: a.text, name: a.name }); apps.push({ id: 'a' + i, name: a.label, map: p.guess.map }); }
    const r = await w.call('analyse', { ws: 'demo', idp: { id: 'i', map: idp.guess.map }, apps, settings: C.cleanInventory(D.inventory()).inventory.settings, today: TODAY, idpKind: 'okta' });
    assert.strictEqual(C.summaryLine(r.summary), '7 orphaned accounts in 4 apps · 2 are admins · oldest leaver: 94 days');
    const found = await w.call('lookup', { ws: 'demo', email: at('sam.okafor', 'harborpine.example'), name: 'Sam Okafor' });
    assert.deepStrictEqual(found.map((x) => x.appName).sort(), ['File share', 'Team chat', 'Video meetings']);
    assert.deepStrictEqual(await w.call('lookup', { ws: 'own', email: at('sam.okafor', 'harborpine.example') }), [], 'one workspace never answers for the other');
    await assert.rejects(w.call('parse', { id: 'x', role: 'app', file: new File([new Uint8Array(C.LIMITS.fileBytes + 1)], 'huge.csv') }), /over 20 MB/);
    await assert.rejects(w.call('nope', {}), /Unknown step/);
  } finally { w.stop(); }
});

/* ================================================================== *
 * The page's promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the hero, the mock and the lab card too; 44px targets; nothing scrolls the page sideways', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'code-bg', 'bar-bg']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('accent-ink', 'accent'); for (const fg of ['text', 'link', 'muted']) ok(fg, 'accent-soft');
    for (const k of ['crit', 'orphan', 'susp', 'ext', 'shared', 'dormant', 'off', 'ok']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); ok(k, 'card'); }
    ok('muted', 'ok-bg'); ok('ok-bg', 'ok'); ok('mark-ink', 'mark-bg'); ok('tok-ink', 'tok-bg'); ok('link', 'card2');
    for (const k of ['tone-crit', 'tone-orphan', 'tone-susp', 'tone-ext', 'tone-shared', 'tone-dormant', 'tone-ok']) ok(k, 'card', 3);
  }
  for (const bg of ['#1e1b4b', '#312e81', '#7c2d12']) for (const fg of ['#ffffff', '#eeedfb', '#e4e2f7', '#fed7aa']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  for (const [fg, bg] of [['#431407', '#fed7aa'], ['#1a1730', '#fbfaff'], ['#514c66', '#fbfaff'], ['#9f1239', '#ffe4e6'], ['#b42318', '#fbfaff']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}`);
  const lab = require('../../../lab').get('lastday');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const sel of ['.btn', '.link-btn', '.seg button', '.filters button', '.tile', '.input, textarea.input, select.input', '.check', '.hwchips button, .stepchips button']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: 4[4-9]px').test(css), `${sel}: 44px`);
  assert.ok(/\.tick \{[^}]*width: 44px; height: 44px/.test(css) && /\.tbody \{[^}]*min-height: 44px/.test(css));
  assert.ok(/\.frow \{[^}]*min-height: 60px/.test(css) && /\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/\.ftable-wrap \{[^}]*overflow: auto/.test(css) && /\.tablewrap \{[^}]*overflow: auto/.test(css) && /\.out \{[^}]*overflow: auto/.test(css) && /\.filters \{[^}]*overflow-x: auto/.test(css) && /\.masked \{[^}]*overflow: auto/.test(css), 'tables, previews and exports scroll in their own box');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped and opt-in, no clock or network in the core, every file, typed and model string escaped', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js) && /localStorage\.removeItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|indexedDB|document\.cookie/.test(js));
  assert.match(js, /function saveSoon\(\) \{ if \(!state\.keep\) return;/, 'nothing is stored unless this device said yes');
  assert.match(js, /function saveNow\(\) \{\n {4}if \(!state\.keep\) return;/);
  assert.match(js, /keep: false/);
  assert.ok(!/eval\(|new Function|setTimeout\(['"]/.test(js + read('public/lastday-core.js') + read('public/lastday-worker.js') + read('public/demo.js')), 'no eval of any kind');
  assert.match(js, /new Worker\('lastday-worker\.js'\)/, 'the worker is a same-origin file - the CSP allows it');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/request', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/inventory', 'api/me'].sort(), 'the page asks for nothing else - no route takes a person');
  assert.match(js, /api\('POST', 'api\/ai\/request', \{ text: m\.text, today: state\.today, dayFirst: DAY_FIRST \}\)/, 'the AI call sends the masked text shown, and nothing else');
  assert.match(js, /api\('PUT', 'api\/inventory', \{ inventory: body, base:/, 'sync sends the inventory and a base, nothing else');
  const files = ['public/index.html', 'public/app.js', 'public/lastday-core.js', 'public/demo.js', 'public/lastday-worker.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  for (const f of ['public/lastday-core.js', 'public/demo.js', 'public/lastday-worker.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(src), `${f} has no dice and no clock`);
  }
  // Every interpolation of something a file, a person, the server or a model wrote goes through esc() or tokHtml().
  const strip = (src) => { let out = ''; let i = 0; const re = /\b(esc|tokHtml)\(/g; let m; while ((m = re.exec(src))) { if (m.index < i) continue; out += src.slice(i, m.index) + 'SAFE'; let depth = 0, j = m.index + m[0].length - 1; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; re.lastIndex = i; } return out + src.slice(i); };
  // Only lines that build markup can inject anything.
  const risky = strip(js).split('\n').filter((l) => /</.test(l) && !/toast\(|confirm\(|prompt\(|copy\(|download\(|textContent|\.value = /.test(l)).join('\n')
    .match(/['"]\s*\+\s*(x\.\w+|r\.\w+|p\.\w+|a\.\w+|f\.\w+|t\.\w+|lv\.\w+|u\.\w+|s\.\w+|d\.\w+|top\.\w+|first\.\w+|sys\.\w+|name|text|key|q|c|v|m|state1|gone|err\.message|e\.message|me\.email|res\.\w+)\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbrief\b|\btext\b|\binventory\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /lastday-shell-v1/.test(sw) && ['lastday-core.js', 'lastday-worker.js', 'demo.js', 'app.js'].every((f) => sw.includes(`'${f}'`)) && /k\.indexOf\('lastday-'\) === 0/.test(sw), 'the service worker never answers api/ and only clears its own caches');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  assert.match(read('public/demo.js'), /MADE-UP dental practice/);
});

test('the copy: neutral wording (they/them - no he, she, his, her), no invisible characters in any source file, no key- or token-shaped strings', () => {
  const strings = (src) => [...src.matchAll(/'([^'\\\n]|\\.){3,}'|`[^`]{3,}`|"[^"\n]{3,}"/g)].map((m) => m[0]).join('\n');
  const all = strings(read('public/app.js')) + strings(read('public/demo.js')) + read('public/index.html') + strings(read('server.js')) + strings(read('lib/ai.js')) + read('CLAUDE.md');
  const gendered = all.match(/\b(he|she|his|hers|him|himself|herself)\b|\bher\b/gi);
  assert.strictEqual(gendered, null, `gendered: ${gendered}`);
  const core = read('public/lastday-core.js');
  const coreCopy = [...core.matchAll(/'([^'\\\n]|\\.){12,}'/g)].map((m) => m[0]).filter((s) => / /.test(s) && !/\(\?:|\\b|\[\^/.test(s)).join('\n');
  assert.strictEqual(coreCopy.match(/\b(he|she|his|hers|him)\b|\bher\b/gi), null, 'the core\u2019s sentences are neutral too');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  for (const f of walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(src), `${path.relative(ROOT, f)} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(f)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}/.test(src), `${path.relative(ROOT, f)} carries a key-shaped string`);
  }
});

test('local-only switches throw on Cloud Run; the lab prefix is read; the store is never queried', () => {
  for (const [mod, env] of [['./lib/store', { LASTDAY_MEMORY: '1' }], ['./lib/fakeai', { LASTDAY_FAKE_AI: '1' }], ['./server', { LASTDAY_FAKE_AI: '1', LASTDAY_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, LASTDAY_MEMORY: '', LASTDAY_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, LASTDAY_MEMORY: '', LASTDAY_COLLECTION_PREFIX: 'lastday_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'lastday_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.ok(!/store\.list\(|orderBy/.test(server), 'one document per account, read by its id');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('inventory'", "store.remove('inventory'", "store.transact('inventory'"]);
});

/* ================================================================== *
 * Over HTTP
 * ================================================================== */

let base;
let ip6 = 1;
function client() {
  const cookies = {};
  const addr = `2001:db8:${(ip6++).toString(16)}::1`;
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await res.text();
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, headers: res.headers };
  };
}
const mail = (who) => `${who}${AT}example.com`;
const uidOf = (email) => Buffer.from(email).toString('base64url');
async function register(who) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const BIG = { x: 'x'.repeat(900 * 1024) };

test('signed out: the page, the worker and the demo work with zero model calls; the inventory and the AI answer 401 before reading a body; no route takes a person', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.verdicts, meta.phases, meta.owners.length], [C.VERDICTS, C.PHASES, 8]);
  for (const f of ['lastday-core.js', 'lastday-worker.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/inventory'], ['PUT', '/api/inventory'], ['DELETE', '/api/inventory'], ['POST', '/api/ai/request']]) assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  for (const [m, p] of [['PUT', '/api/inventory'], ['POST', '/api/ai/request']]) assert.strictEqual((await anon(m, p, BIG)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/scan', '/api/upload', '/api/users', '/api/orphans', '/api/findings', '/api/leavers', '/api/checklist', '/api/request', '/api/match', '/api/people']) assert.strictEqual((await anon('POST', p, { users: [{ email: at('sam') }] })).status, 404, `${p}: there is no route that takes a person`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/request', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/inventory', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai.SYSTEM, /never an instruction/);
  assert.match(ai.SYSTEM, /Never guess what a token stands for/);
});

test('inventory sync: it follows the account; a stale device gets 409 with the account copy; people and user lists refused; nothing identifying stored', async () => {
  const a = await register('sam.systems');
  assert.deepStrictEqual((await a('GET', '/api/inventory')).data, { inventory: null });
  const good = C.cleanInventory(D.inventory()).inventory; delete good.updatedAt;
  const put = await a('PUT', '/api/inventory', { inventory: good, base: null });
  assert.strictEqual(put.status, 200, put.text);
  assert.deepStrictEqual([put.data.inventory.systems.length, put.data.inventory.settings.domains], [9, ['harborpine.example', 'harborpinedental.example']]);
  const v1 = put.data.inventory.updatedAt;
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('sam.systems'), password: 'a long enough password' })).status, 200);
  assert.strictEqual((await b('GET', '/api/inventory')).data.inventory.systems[2].name, 'Team chat');
  const b2 = JSON.parse(JSON.stringify(good)); b2.settings.dormantDays = 60;
  assert.strictEqual((await b('PUT', '/api/inventory', { inventory: b2, base: v1 })).status, 200);
  const stale = await a('PUT', '/api/inventory', { inventory: good, base: v1 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.data.inventory.settings.dormantDays, 60, 'the 409 carries the account copy to merge with');
  assert.strictEqual((await a('PUT', '/api/inventory', { inventory: good, base: null })).status, 409, 'a device that never synced cannot overwrite');
  const cur = (await a('GET', '/api/inventory')).data.inventory.updatedAt;
  const withBad = (mut) => { const r = JSON.parse(JSON.stringify(good)); mut(r); return { inventory: r, base: cur }; };
  for (const bad of [
    withBad((r) => { r.users = [{ email: at('sam.okafor'), name: 'Sam Okafor' }]; }),
    withBad((r) => { r.leavers = [{ name: 'Sam Okafor' }]; }),
    withBad((r) => { r.systems[0].name = at('sam.okafor'); }),
    withBad((r) => { r.systems[0].owner = 'Dana Whitlock'; }),
    withBad((r) => { r.systems[0].members = ['Sam Okafor']; }),
    withBad((r) => { r.settings.patterns = ['sam.okafor']; }),
    withBad((r) => { r.settings.domains = [at('sam')]; }),
    withBad((r) => { r.systems = Array.from({ length: 61 }, (_, i) => ({ name: 'S' + i, steps: [], owner: 'it' })); }),
    { inventory: good, base: cur, people: ['Sam Okafor'] },
    { inventory: 'nope', base: cur },
  ]) {
    const r = await a('PUT', '/api/inventory', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 120) + ' ' + r.text);
  }
  assert.strictEqual((await a('GET', '/api/inventory')).data.inventory.updatedAt, cur, 'nothing was saved');
  const dump = store._dump();
  assert.ok(!dump.includes('sam.systems') && !dump.includes(uidOf(mail('sam.systems'))), 'filed under an HMAC, never the account id or email');
  assert.ok(!/Sam Okafor|sam\.okafor|Dana Whitlock/.test(dump), 'no person from a refused body');
  assert.ok(dump.includes(ownerTag(uidOf(mail('sam.systems')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const doc = Object.values(JSON.parse(dump).find(([p]) => p === 'inventory')[1]).map(([, d]) => d)[0];
  assert.deepStrictEqual(Object.keys(doc).sort(), ['inventory', 'owner', 'updatedAt'], 'the document is the tag, the inventory and a time');
  assert.deepStrictEqual(Object.keys(doc.inventory).sort(), ['settings', 'systems', 'version']);
  const other = await register('kim.other');
  assert.deepStrictEqual((await other('GET', '/api/inventory')).data, { inventory: null }, 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', '/api/inventory')).status, 200);
  assert.deepStrictEqual((await b('GET', '/api/inventory')).data, { inventory: null });
});

test('read a messy request over HTTP: masked text only, an unmasked address refused with no model call, the answer checked - and the model saw no name, address or phone', async () => {
  const ana = await register('ana.reads');
  const calls = await modelCalls();
  const raw = D.messyRequest();
  for (const bad of [{}, { text: raw }, { text: 'Sam leaves Friday, mail ' + at('sam.okafor'), today: TODAY }, { text: 'call 207 555 0143', today: TODAY }, { text: 'x', today: TODAY, users: [] }, { text: 'x'.repeat(4001), today: TODAY }, []]) {
    const r = await ana('POST', '/api/ai/request', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 80) + ' ' + r.text);
  }
  assert.strictEqual((await ana('POST', '/api/ai/request', { text: 'mail ' + at('sam'), today: TODAY })).data.code, 'unmasked-email');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const people = C.parseRequest(raw, { today: TODAY }).people.concat(['Jojo', 'Maya']);
  const m = C.maskRequest(raw, people);
  assert.ok(m.text.includes('[person') && !/Jojo|Maya/.test(m.text));
  const n0 = fakeClient.calls.length;
  const r = await ana('POST', '/api/ai/request', { text: m.text, today: TODAY, dayFirst: false });
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const sent = fakeClient.calls[n0];
  assert.strictEqual(sent.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(sent.tool_choice, { type: 'tool', name: 'read_request' });
  const userText = sent.messages[0].content[0].text;
  assert.match(userText, /^Today is 2026-11-03 \(a Tuesday\)\./);
  assert.match(userText, /<<<REQUEST\n[\s\S]*\nREQUEST>>>/, 'the request is fenced as untrusted');
  assert.ok(!/Jojo|Maya|\S@\S/.test(JSON.stringify(sent)), 'the model saw no name and no address');
  const f = r.data.fields;
  assert.deepStrictEqual([f.name.value, f.lastDay.value, f.lastTime.value, f.involuntary.value, f.filesTo.value], ['[person1]', '2026-11-14', '08:00', true, 'whoever covers hygiene']);
  assert.strictEqual(C.unmask(f.name.value, m.map), 'Jojo');
  assert.ok(r.data.questions.length >= 1);
  assert.ok(!store._dump().includes('hygiene'), 'nothing stored');
  fakeClient.mode = 'inject';
  const inj = await ana('POST', '/api/ai/request', { text: m.text, today: TODAY });
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<img|onerror|evil|hunter2|\u202e|25:99|2031/i.test(inj.text), inj.text.slice(0, 400));
  assert.deepStrictEqual(Object.keys(inj.data.fields).sort(), ['filesTo', 'hardware']);
  assert.ok(inj.data.dropped >= 5);
  fakeClient.mode = 'blank';
  assert.strictEqual((await ana('POST', '/api/ai/request', { text: m.text, today: TODAY })).status, 422);
  fakeClient.mode = 'maxtokens';
  assert.match((await ana('POST', '/api/ai/request', { text: m.text, today: TODAY })).data.error, /ran long/);
  fakeClient.mode = 'upstream401';
  const up = await ana('POST', '/api/ai/request', { text: m.text, today: TODAY });
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await ana('POST', '/api/ai/request', { text: m.text, today: TODAY });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  const body = { text: '[person1] leaves Friday.', today: TODAY };
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/ai/request', body);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/lastday/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await eve('POST', '/api/ai/request', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/request', body)).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/request', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-lastday-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/request', body);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/request', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-lastday-${day}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/lastday', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/lastday`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
