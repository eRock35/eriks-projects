// Pure rules first, then the streaming worker, then end to end over HTTP:
//   PARITY_MEMORY=1 PARITY_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /parity, the way
// the lab mounts it, so the auth cookie, the budget gate and the metered
// route's parser order are exercised as deployed. Model calls are counted
// from the identity's usage rows - the same rows that bill a real account -
// and what reached "the model" is read from the fake client's own log.
//
// Every table here is synthetic: the example migration (public/demo.js) or
// rows written in the test.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.PARITY_MEMORY !== '1' || process.env.PARITY_FAKE_AI !== '1') {
  console.error('run with PARITY_MEMORY=1 PARITY_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, fakeCalls } = require('../server');
const C = require('../public/parity-core');
const D = require('../public/demo');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- helpers ---------------- */

function csvRows(text, opts) { return C.parseText(text, 'x.csv', opts); }
function profile(parsed) { const p = C.createProfiler(parsed.columns); parsed.rows.forEach(p.add); return p.finish(); }
/** Two small tables in, a result out: name/value objects for readability. */
function table(cols, rows) { return { columns: cols, rows: rows.map((r) => cols.map((c) => (r[c] === undefined ? null : r[c]))) }; }
function compareTables(b, a, recipe) {
  const pb = profile(b), pa = profile(a);
  const plan = C.compilePlan(recipe, pb.columns, pa.columns);
  assert.deepStrictEqual(plan.errors, []);
  return C.compareRows(b.rows, a.rows, plan, { at: 'T' });
}
const one = (from, to, rules) => ({ from: [from], to: [to || from], rules: rules || [] });
function demoAll() {
  const d = D.build();
  const b = C.parseText(d.before.text, d.before.name), a = C.parseText(d.after.text, d.after.name);
  const pb = profile(b), pa = profile(a);
  const am = C.automap(pb.columns, pa.columns);
  const recipe = { pairs: am.pairs.map((p) => ({ from: p.from, to: p.to, sep: p.sep, rules: [] })), key: C.suggestKey(am.pairs, pb.columns, pa.columns) };
  let plan = C.compilePlan(recipe, pb.columns, pa.columns);
  const learned = C.learnRules(recipe, pb.columns, pa.columns, C.sampleJoin(plan, b.rows, a.rows));
  learned.forEach((l) => { recipe.pairs[l.pair].rules = C.sortRules(recipe.pairs[l.pair].rules.concat(l.rules)); });
  plan = C.compilePlan(recipe, pb.columns, pa.columns);
  return { d, b, a, pb, pa, am, recipe, plan, learned, res: C.compareRows(b.rows, a.rows, plan, { at: 'T' }) };
}
let DEMO = null;
const demo = () => DEMO || (DEMO = demoAll());
const KEY = [0x03020100, 0x07060504, 0x0b0a0908, 0x0f0e0d0c];
const otherKey = [1, 2, 3, 4];

/* ---------------- reading ---------------- */

test('CSV: quotes, "" inside quotes, line breaks inside quotes, CRLF, a BOM, null tokens unquoted only', () => {
  const t = '\uFEFFid,name,note\r\n1,"Smith, Ann","said ""hi""\r\nthen left"\r\n2,NULL,"NULL"\r\n3,,""\r\n';
  const p = csvRows(t);
  assert.deepStrictEqual(p.columns, ['id', 'name', 'note'], 'the BOM is not part of the first name');
  assert.strictEqual(p.header, true);
  assert.deepStrictEqual(p.rows, [['1', 'Smith, Ann', 'said "hi"\r\nthen left'], ['2', null, 'NULL'], ['3', '', '']]);
  const e = csvRows('id,a\n1,\n2,x\n', { emptyNull: true });
  assert.deepStrictEqual(e.rows, [['1', null], ['2', 'x']], 'Postgres-style: an empty cell is null');
});

test('CSV: the same rows whatever the chunking (a stream splits anywhere, even inside "")', () => {
  const t = 'a;b;c\r\n"x;1";"he said ""no""";3\r\n"line\nbreak";"";\r\n4;5;6';
  const whole = []; const p = C.createCsvParser({ delimiter: ';', onRow: (r) => whole.push(r) }); p.push(t); p.end();
  assert.strictEqual(whole.length, 4);
  assert.deepStrictEqual(whole[3], ['4', '5', '6'], 'the last line needs no line break');
  for (let size = 1; size <= 9; size++) {
    const out = []; const q = C.createCsvParser({ delimiter: ';', onRow: (r) => out.push(r) });
    for (let i = 0; i < t.length; i += size) q.push(t.slice(i, i + size));
    q.end();
    assert.deepStrictEqual(out, whole, `chunks of ${size}`);
  }
  const cr = []; const q2 = C.createCsvParser({ delimiter: ',', onRow: (r) => cr.push(r) }); q2.push('a,b\r1,2\r'); q2.end();
  assert.deepStrictEqual(cr, [['a', 'b'], ['1', '2']], 'old Mac line ends (CR only)');
});

test('CSV: delimiter sniffed (comma, semicolon, tab, pipe); ragged rows padded or cut and counted', () => {
  assert.strictEqual(C.sniff('a;b;c\n1;2,5;3\n4;5;6\n', 'x.csv').delimiter, ';');
  assert.strictEqual(C.sniff('a\tb\n1\t2\n', 'x.txt').delimiter, '\t');
  assert.strictEqual(C.sniff('a|b|c\n1|2|3\n', 'x').delimiter, '|');
  assert.strictEqual(C.sniff('a,b\n"1;2",3\n', 'x').delimiter, ',');
  assert.strictEqual(C.sniff('x', 'data.tsv').delimiter, '\t');
  assert.strictEqual(C.sniff('{"a":1}\n', 'data.txt').format, 'jsonl');
  const r = csvRows('a,b,c\n1,2\n3,4,5,6\n7,8,9\n');
  assert.deepStrictEqual(r.rows, [['1', '2', null], ['3', '4', '5'], ['7', '8', '9']]);
  assert.strictEqual(r.issues.length, 2);
  assert.match(r.issues[0], /1 row had fewer cells/);
  assert.match(r.issues[1], /1 row had more cells/);
});

test('header detection: labels yes; numbers, dates, blanks or repeats in row one no', () => {
  assert.strictEqual(csvRows('id,name\n1,Ann\n').header, true);
  assert.strictEqual(csvRows('1,Ann\n2,Ben\n').header, false);
  assert.deepStrictEqual(csvRows('1,Ann\n2,Ben\n').columns, ['col_1', 'col_2']);
  assert.strictEqual(csvRows('2024-01-01,x\n2024-01-02,y\n').header, false);
  assert.strictEqual(csvRows('a,a\n1,2\n').header, false, 'repeated names are data');
  assert.strictEqual(csvRows('a,\n1,2\n').header, false);
  assert.strictEqual(csvRows('1,Ann\n2,Ben\n', { header: true }).header, true, 'the person can say otherwise');
  assert.deepStrictEqual(C.nameColumns(['x', 'X', '', ' x '], 4), ['x', 'X_2', 'col_3', 'x_3'], 'names are made unique (case-blind) and never empty');
});

test('JSON Lines: keys in first-seen order, a missing key is null, numbers kept as written, bad lines counted', () => {
  const t = '{"id":1,"amt":12.50,"big":12345678901234567890}\r\n{"id":2,"tags":["a"],"obj":{"k":1},"ok":true}\n\nnot json\n[1,2]\n{"id":3,"amt":null}';
  const p = C.parseText(t, 'x.jsonl');
  assert.deepStrictEqual(p.columns, ['id', 'amt', 'big', 'tags', 'obj', 'ok']);
  assert.deepStrictEqual(p.rows[0], ['1', '12.50', '12345678901234567890', null, null, null], 'the source text of a number, not its float');
  assert.deepStrictEqual(p.rows[1], ['2', null, null, '["a"]', '{"k":1}', 'true']);
  assert.deepStrictEqual(p.rows[2], ['3', null, null, null, null, null]);
  assert.deepStrictEqual(p.issues, ['1 line were not valid JSON and were skipped', '1 line were not JSON objects and were skipped']);
});

/* ---------------- types ---------------- */

test('type inference: int, decimal, bool, dates and date-times with their format, text; null-ish values recognised', () => {
  const t = 'i,d,b,day,us,eu,ts,iso,txt,zip,nul\n' +
    '1,1.5,true,2024-01-31,01/31/2024,31/01/2024,2024-01-31 10:00:00,2024-01-31T10:00:00Z,abc,02134,NULL\n' +
    '-2,1e3,no,2024-02-01,2/1/2024,13/02/2024,2024-02-01 23:59:59,2024-02-01T10:00:00.250Z,de,10001,\\N\n' +
    'N/A,"1,234.50",Y,NULL,NULL,NULL,NULL,NULL,,00042,None\n';
  const P = profile(csvRows(t));
  const by = Object.fromEntries(P.columns.map((c) => [c.name, c]));
  assert.deepStrictEqual([by.i.type, by.i.nulls], ['int', 1]);
  assert.strictEqual(by.d.type, 'decimal');
  assert.strictEqual(by.b.type, 'bool');
  assert.deepStrictEqual([by.day.type, by.day.format], ['date', 'YYYY-MM-DD']);
  assert.deepStrictEqual([by.us.type, by.us.format], ['date', 'MM/DD/YYYY'], 'a day over 12 settles which is the month');
  assert.deepStrictEqual([by.eu.type, by.eu.format], ['date', 'DD/MM/YYYY']);
  assert.deepStrictEqual([by.ts.type, by.ts.format], ['datetime', 'YYYY-MM-DD HH:mm:ss']);
  assert.strictEqual(by.iso.type, 'datetime');
  assert.strictEqual(by.iso.format, 'YYYY-MM-DDTHH:mm:ss.SSSZ', 'with and without milliseconds in one column');
  assert.strictEqual(C.parseDate('2024-01-31T10:00:00Z', 'YYYY-MM-DDTHH:mm:ss.SSSZ').ms, Date.UTC(2024, 0, 31, 10));
  assert.deepStrictEqual([by.txt.type, by.txt.empties], ['text', 1]);
  assert.strictEqual(by.zip.type, 'text', 'leading zeros are a code, not a number');
  assert.deepStrictEqual([by.nul.type, by.nul.nulls], ['empty', 3]);
  assert.strictEqual(C.parseDate('2024-02-30', 'YYYY-MM-DD'), null, 'no February 30th');
  assert.strictEqual(C.parseDate('2023-02-29', 'YYYY-MM-DD'), null);
  assert.ok(C.parseDate('2024-02-29', 'YYYY-MM-DD'));
});

test('numbers are exact decimal strings: canonical form, x100 and /100, rounding half away from zero', () => {
  assert.strictEqual(C.canonNum('0012.500'), '12.5');
  assert.strictEqual(C.canonNum('-0.00'), '0');
  assert.strictEqual(C.canonNum('1,234.50'), '1234.5');
  assert.strictEqual(C.canonNum('1.5e3'), '1500');
  assert.strictEqual(C.canonNum('12e-3'), '0.012');
  assert.strictEqual(C.canonNum('12 apples'), null);
  assert.strictEqual(C.canonNum('1,23'), null);
  assert.strictEqual(C.shiftNum('123456', -2), '1234.56');
  assert.strictEqual(C.shiftNum('5', -2), '0.05');
  assert.strictEqual(C.shiftNum('-12.3', 2), '-1230');
  assert.strictEqual(C.roundNum('2.345', 2), '2.35');
  assert.strictEqual(C.roundNum('-2.345', 2), '-2.35');
  assert.strictEqual(C.roundNum('9.995', 2), '10');
  assert.strictEqual(C.roundNum('0.1', 3), '0.1');
});

/* ---------------- mapping ---------------- */

test('auto-map: renames, units, splits and joins by name, with a confidence; types that cannot match are not paired', () => {
  const col = (name, type) => ({ name, type, rows: 10, nulls: 0, empties: 0, distinct: 10 });
  const m = C.automap(
    [col('cust_id', 'int'), col('full_name', 'text'), col('balance_cents', 'int'), col('signup_dt', 'date'), col('EmailAddress', 'text'), col('status_cd', 'text'), col('legacy_flag', 'text')],
    [col('customer_id', 'int'), col('first_name', 'text'), col('last_name', 'text'), col('balance', 'decimal'), col('signupDate', 'date'), col('email_address', 'text'), col('status', 'text'), col('created_at', 'datetime')],
  );
  const pair = (from) => m.pairs.find((p) => p.from.join('+') === from);
  assert.deepStrictEqual(pair('cust_id').to, ['customer_id']);
  assert.strictEqual(pair('cust_id').conf, 'exact', 'cust is customer, by synonym');
  assert.deepStrictEqual(pair('full_name').to, ['first_name', 'last_name']);
  assert.strictEqual(pair('full_name').sep, ' ');
  assert.deepStrictEqual(pair('balance_cents').to, ['balance']);
  assert.strictEqual(pair('balance_cents').conf, 'likely');
  assert.deepStrictEqual(pair('signup_dt').to, ['signupDate'], 'snake and camel case, dt is date');
  assert.deepStrictEqual(pair('EmailAddress').to, ['email_address']);
  assert.deepStrictEqual(pair('status_cd').to, ['status']);
  assert.deepStrictEqual(m.unmatchedBefore, ['legacy_flag']);
  assert.deepStrictEqual(m.unmatchedAfter, ['created_at']);
  const join = C.automap([col('fname', 'text'), col('lname', 'text')], [col('full_name', 'text')]);
  assert.deepStrictEqual(join.pairs.map((p) => [p.from, p.to]), [[['fname', 'lname'], ['full_name']]], 'first + last joined into one name');
  const types = C.automap([col('order_date', 'date')], [col('order_num', 'int')]);
  assert.deepStrictEqual(types.pairs, [], 'a date and a number are not a rename');
});

test('the key: a unique, never-null one-to-one pair, an id first', () => {
  const c = (name, distinct, nulls) => ({ name, type: 'int', rows: 100, nulls: nulls || 0, empties: 0, distinct });
  const pairs = [one('email'), one('row_num'), one('customer_id')];
  assert.deepStrictEqual(C.suggestKey(pairs, [c('email', 100), c('row_num', 100), c('customer_id', 100)], [c('email', 100), c('row_num', 100), c('customer_id', 99)]), ['customer_id'], 'one duplicate after is allowed: that is a finding');
  assert.deepStrictEqual(C.suggestKey(pairs, [c('email', 100), c('row_num', 90), c('customer_id', 100, 1)], [c('email', 100), c('row_num', 90), c('customer_id', 100)]), ['email']);
  assert.deepStrictEqual(C.suggestKey(pairs, [c('email', 5), c('row_num', 5), c('customer_id', 5)], [c('email', 5), c('row_num', 5), c('customer_id', 5)]), []);
});

/* ---------------- rules ---------------- */

function ruleCase(rules, beforeVal, afterVal, types) {
  const bt = (types && types[0]) || 'text', at = (types && types[1]) || 'text';
  const bcol = { name: 'v', type: bt, format: (types && types[2]) || null }, acol = { name: 'v', type: at, format: (types && types[3]) || null };
  const plan = C.compilePlan({ pairs: [{ from: ['v'], to: ['v'], rules }], key: [] }, [bcol], [acol]);
  const p = plan.pairs[0];
  return { b: C.normBefore(p, [beforeVal]), a: C.normAfter(p, [afterVal]) };
}
test('every rule, on the side it belongs to', () => {
  let r = ruleCase([{ rule: 'trim' }], '  Ann Lee \t', 'Ann Lee'); assert.strictEqual(r.b, r.a);
  r = ruleCase([], '  Ann', 'Ann'); assert.notStrictEqual(r.b, r.a, 'no rule, no trim');
  r = ruleCase([{ rule: 'fold' }], 'Ann.Lee@Example.COM', 'ann.lee@example.com'); assert.strictEqual(r.b, r.a);
  r = ruleCase([{ rule: 'fold' }], 'ann', 'ANN'); assert.strictEqual(r.b, r.a, 'case fold is both sides');
  r = ruleCase([{ rule: 'scale', op: 'div100' }], '123450', '1234.50', ['int', 'decimal']); assert.deepStrictEqual([r.b, r.a], ['1234.5', '1234.5']);
  r = ruleCase([{ rule: 'scale', op: 'mul100' }], '12.34', '1234', ['decimal', 'int']); assert.strictEqual(r.b, r.a);
  r = ruleCase([{ rule: 'round', places: 2 }], '12.345', '12.35', ['decimal', 'decimal']); assert.strictEqual(r.b, r.a);
  r = ruleCase([{ rule: 'round', places: 2 }], '12.35', '12.3500001', ['decimal', 'decimal']); assert.strictEqual(r.b, r.a, 'rounding is both sides');
  r = ruleCase([{ rule: 'date', from: 'MM/DD/YYYY', to: 'YYYY-MM-DD' }], '03/05/2024', '2024-03-05', ['date', 'date', 'MM/DD/YYYY', 'YYYY-MM-DD']); assert.deepStrictEqual([r.b, r.a], ['2024-03-05', '2024-03-05']);
  r = ruleCase([{ rule: 'date', from: 'YYYY-MM-DD HH:mm:ss', to: 'YYYY-MM-DDTHH:mm:ssZ' }, { rule: 'tz', hours: -5 }], '2024-03-05 14:00:00', '2024-03-05T09:00:00Z', ['datetime', 'datetime', 'YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DDTHH:mm:ssZ']); assert.strictEqual(r.b, r.a, 'date, then the zone');
  r = ruleCase([{ rule: 'tz', hours: 5.5 }], '2024-03-05T00:00:00Z', '2024-03-05T05:30:00Z', ['datetime', 'datetime', 'YYYY-MM-DDTHH:mm:ssZ', 'YYYY-MM-DDTHH:mm:ssZ']); assert.strictEqual(r.b, r.a, 'a half-hour zone');
  r = ruleCase([{ rule: 'map', table: [['A', 'active'], ['I', 'inactive']] }], 'A', 'active'); assert.strictEqual(r.b, r.a);
  r = ruleCase([{ rule: 'map', table: [['A', 'active']] }], 'Z', 'Z'); assert.strictEqual(r.b, r.a, 'an unmapped value passes through');
  r = ruleCase([{ rule: 'nullEmpty' }], null, ''); assert.deepStrictEqual([r.b, r.a], [null, null]);
  r = ruleCase([{ rule: 'nullEmpty' }], '', null); assert.strictEqual(r.b, r.a);
  r = ruleCase([], null, ''); assert.notStrictEqual(r.b, r.a, 'null is not empty unless you say so');
  // ignore: the column is not compared at all.
  const b = table(['id', 'x'], [{ id: '1', x: 'a' }]), a = table(['id', 'x'], [{ id: '1', x: 'b' }]);
  assert.strictEqual(compareTables(b, a, { pairs: [one('id'), one('x', 'x', [{ rule: 'ignore' }])], key: ['id'] }).ok, true);
  assert.strictEqual(compareTables(b, a, { pairs: [one('id'), one('x')], key: ['id'] }).ok, false);
  // a split compares joined, empty parts left out
  const sb = table(['id', 'name'], [{ id: '1', name: 'Mary Ann Smith' }, { id: '2', name: 'Cher' }]), sa = table(['id', 'first', 'last'], [{ id: '1', first: 'Mary Ann', last: 'Smith' }, { id: '2', first: 'Cher', last: '' }]);
  assert.strictEqual(compareTables(sb, sa, { pairs: [one('id'), { from: ['name'], to: ['first', 'last'], sep: ' ', rules: [] }], key: ['id'] }).ok, true);
});

test('rules come from the fixed list only, with checked settings - no code, no unknown format', () => {
  assert.strictEqual(C.cleanRule({ rule: 'eval', code: 'x' }), null);
  assert.strictEqual(C.cleanRule({ rule: 'date', from: '%Y-%m', to: 'YYYY-MM-DD' }), null);
  assert.strictEqual(C.cleanRule({ rule: 'scale', op: 'div7' }), null);
  assert.strictEqual(C.cleanRule({ rule: 'round', places: 11 }), null);
  assert.strictEqual(C.cleanRule({ rule: 'tz', hours: 0 }), null);
  assert.strictEqual(C.cleanRule({ rule: 'tz', hours: 5.3 }), null);
  assert.deepStrictEqual(C.cleanRule({ rule: 'tz', hours: '-3.5', x: 1 }), { rule: 'tz', hours: -3.5 });
  assert.strictEqual(C.cleanRule({ rule: 'map', table: 'A=1' }), null);
  assert.deepStrictEqual(C.cleanRule({ rule: 'map', table: [['A', 'x'], ['A', 'y'], [1, 2], ['B\u202e', 'z']] }), { rule: 'map', table: [['A', 'x'], ['B', 'z']] });
  assert.deepStrictEqual(C.sortRules([{ rule: 'fold' }, { rule: 'trim' }, { rule: 'nope' }, { rule: 'trim' }]).map((r) => r.rule), ['trim', 'fold'], 'one of each, in the fixed order');
  const r = C.cleanRecipe({ pairs: [{ from: ['a'], to: ['A'], rules: [] }, { from: ['ghost'], to: ['B'] }, { from: ['a'], to: ['B'] }, { from: ['b', 'c'], to: ['B', 'C'] }], key: ['A', 'Z'] }, ['a', 'b', 'c'], ['A', 'B', 'C']);
  assert.deepStrictEqual(r.recipe.pairs.map((p) => p.from), [['a']]);
  assert.strictEqual(r.dropped, 3, 'an unknown column, a column used twice, and many-to-many are dropped');
  assert.deepStrictEqual(r.recipe.key, ['A']);
});

test('rules are learned only when they fix many rows and break none, so a few-row defect stays a finding', () => {
  const { learned, recipe } = demo();
  const by = Object.fromEntries(learned.map((l) => [recipe.pairs[l.pair].to.join('+'), l.rules.map((r) => r.rule)]));
  assert.deepStrictEqual(by, { 'first_name+last_name': ['trim'], email: ['fold'], signup_date: ['date'], balance: ['scale'], status: ['map'], last_login_at: ['date'] });
  assert.ok(!learned.some((l) => l.rules.some((r) => r.rule === 'tz' || r.rule === 'nullEmpty')), 'the shifted batch and the one empty phone are not learned away');
});

/* ---------------- findings and patterns ---------------- */

test('every pattern recogniser, positive and negative', () => {
  const R = (e, g, t) => C.recognize(e, g, t || 'text');
  assert.strictEqual(R(null, '').id, 'null2empty');
  assert.strictEqual(R('', null).id, 'empty2null');
  assert.strictEqual(R('x', null).id, 'lost');
  assert.strictEqual(R(null, 'x').id, 'filled');
  assert.deepStrictEqual(R('Northwind Logistics', 'Northwind Lo'), { id: 'trunc', n: 12 });
  assert.notStrictEqual(R('Northwind', 'Northwand').id, 'trunc', 'a different ending is not a truncation');
  assert.notStrictEqual(R('abc', 'abcd').id, 'trunc', 'longer is not truncated');
  assert.strictEqual(R('Ann Lee', 'ANN LEE').id, 'case');
  assert.strictEqual(R('Ann Lee', 'Ann  Lee ').id, 'space');
  assert.strictEqual(R('Ann', 'Bob').id, 'other');
  assert.strictEqual(R('Cafe\u0301', 'Café').id, 'unicode');
  assert.strictEqual(R('Café', 'CafÃ©').id, 'mojibake');
  assert.strictEqual(R('12.5', '-12.5').id, 'sign');
  assert.notStrictEqual(R('0', '0').id, 'sign');
  assert.deepStrictEqual(R('12.345', '12.35'), { id: 'rounded', n: 2 });
  assert.deepStrictEqual(R('12.345', '12'), { id: 'rounded', n: 0 });
  assert.strictEqual(R('12.345', '12.34').id, 'number', 'rounding down at 5 is not rounding');
  assert.strictEqual(R('1234', '12.34').id, 'scaled');
  assert.strictEqual(R('7', '8').id, 'number');
  assert.deepStrictEqual(R('2024-03-05T10:00:00Z', '2024-03-05T14:00:00Z'), { id: 'shift', n: 4 });
  assert.deepStrictEqual(R('2024-03-05T10:00:00Z', '2024-03-05T04:30:00Z'), { id: 'shift', n: -5.5 });
  assert.deepStrictEqual(R('2024-03-05', '2024-03-04'), { id: 'dayshift', n: -1 });
  assert.strictEqual(R('2024-03-05T10:00:00Z', '2024-03-05T10:00:07Z').id, 'date', 'seven seconds is not a zone');
  assert.strictEqual(R('03/05/2024', '2024-03-05', 'date').id, 'format');
});

test('every finding type, with exact keys: missing, extra, a duplicated key, value changes per column, a key that repeats on both sides', () => {
  const cols = ['id', 'name', 'amt'];
  const b = table(cols, [{ id: '1', name: 'Ann', amt: '10' }, { id: '2', name: 'Ben', amt: '20' }, { id: '3', name: 'Cy', amt: '30' }, { id: '4', name: 'Di', amt: '40' }, { id: '7', name: 'G', amt: '1' }, { id: '7', name: 'H', amt: '2' }]);
  const a = table(cols, [{ id: '1', name: 'Ann', amt: '10' }, { id: '2', name: 'BEN', amt: '-20' }, { id: '4', name: 'Di', amt: '40' }, { id: '4', name: 'Di', amt: '40' }, { id: '5', name: 'Ed', amt: '50' }, { id: '7', name: 'G', amt: '1' }, { id: '7', name: 'H', amt: '2' }]);
  const res = compareTables(b, a, { pairs: [one('id'), one('name'), one('amt')], key: ['id'] });
  const k = (kind, col) => res.findings.find((f) => f.kind === kind && (!col || f.column === col));
  assert.deepStrictEqual(k('missing').examples.map((e) => e.key), ['3']);
  assert.deepStrictEqual(k('extra').examples.map((e) => e.key), ['5']);
  assert.deepStrictEqual(k('dupkey').examples.map((e) => [e.key, e.before, e.after]), [['4', 1, 2]]);
  assert.strictEqual(k('dupkey').title, '1 row was loaded more than once');
  assert.deepStrictEqual(k('mismatch', 'name').examples.map((e) => [e.key, e.expected, e.found, e.pattern]), [['2', 'Ben', 'BEN', 'case']]);
  assert.deepStrictEqual(k('mismatch', 'amt').examples.map((e) => [e.key, e.pattern]), [['2', 'sign']]);
  assert.ok(k('notunique').info, 'a key repeated the same way on both sides is a note, not a problem');
  assert.strictEqual(res.problems, 5);
  assert.strictEqual(res.headline, '5 problems in 6 rows');
  const same = compareTables(b, b, { pairs: [one('id'), one('name'), one('amt')], key: ['id'] });
  assert.strictEqual(same.headline, 'Matches ✓');
  assert.strictEqual(same.ok, true);
});

test('aggregates per column, side by side: counts, nulls, distinct, exact sums, min and max, longest text', () => {
  const b = table(['id', 'amt', 'day', 'txt'], [{ id: '1', amt: '0.1', day: '2024-01-01', txt: 'abc' }, { id: '2', amt: '0.2', day: '2024-03-01', txt: null }]);
  const a = table(['id', 'amt', 'day', 'txt'], [{ id: '1', amt: '0.10', day: '2024-01-01', txt: 'abc' }, { id: '2', amt: '0.20', day: '2024-03-02', txt: '' }]);
  const res = compareTables(b, a, { pairs: [one('id'), one('amt'), one('day'), one('txt')], key: ['id'] });
  const agg = Object.fromEntries(res.aggregates.map((c) => [c.column, Object.fromEntries(c.checks.map((x) => [x.metric, x]))]));
  assert.deepStrictEqual([agg.amt.sum.before, agg.amt.sum.after, agg.amt.sum.ok], ['0.3', '0.3', true], '0.1 + 0.2 is 0.3 exactly');
  assert.deepStrictEqual([agg.amt.min.before, agg.amt.max.after], ['0.1', '0.2']);
  assert.deepStrictEqual([agg.day.max.before, agg.day.max.after, agg.day.max.ok], ['2024-03-01', '2024-03-02', false]);
  assert.deepStrictEqual([agg.txt.nulls.before, agg.txt.nulls.after, agg.txt.empties.after], [1, 0, 1]);
  assert.deepStrictEqual([agg.txt.maxLen.before, agg.txt.maxLen.ok], [3, true]);
  assert.strictEqual(agg.amt.maxLen, undefined, 'no "longest" for a number');
  assert.ok(res.aggregates.find((c) => c.column === 'id').key);
});

test('deterministic: the same result twice, and the same verdict and fingerprint whatever the row order', () => {
  const { b, a, plan } = demo();
  const r1 = JSON.stringify(C.compareRows(b.rows, a.rows, plan, { at: 'T' }));
  const r2 = JSON.stringify(C.compareRows(b.rows, a.rows, plan, { at: 'T' }));
  assert.strictEqual(r1, r2);
  const rev = (x) => x.slice().reverse();
  const shuffled = C.compareRows(rev(b.rows), rev(a.rows), plan, { at: 'T' });
  const sig = (r) => r.findings.map((f) => [f.kind, f.column, f.rows, (f.patterns || []).map((p) => p.label).join()]).sort().join('|');
  assert.strictEqual(sig(shuffled), sig(JSON.parse(r1)));
  const fp = (rows) => { const h = C.createHasher(plan, 'after'); rows.forEach(h.add); return C.fingerprintFrom(h.finish(), plan, 'after', KEY, { at: 'T' }); };
  assert.deepStrictEqual(fp(a.rows), fp(rev(a.rows)));
});

test('the example migration shows every planted defect - and nothing else', () => {
  const { d, res, recipe } = demo();
  const P = d.planted;
  assert.deepStrictEqual(recipe.key, ['customer_id']);
  const got = res.findings.map((f) => [f.kind, f.column || '', f.rows, f.pattern || '']);
  assert.deepStrictEqual(got.sort(), [
    ['dupkey', '', 1, ''],
    ['missing', '', 3, ''],
    ['mismatch', 'company_name', P.truncated, 'trunc'],
    ['mismatch', 'last_login_at', P.shifted, 'shift'],
    ['mismatch', 'phone', 1, 'null2empty'],
  ].sort());
  const f = (kind, col) => res.findings.find((x) => x.kind === kind && (!col || x.column === col));
  assert.deepStrictEqual(f('missing').examples.map((e) => e.key), P.dropped.map(String));
  assert.deepStrictEqual(f('dupkey').examples.map((e) => [e.key, e.before, e.after]), [[String(P.twice), 1, 2]]);
  assert.strictEqual(f('mismatch', 'company_name').title, `company_name: ${P.truncated} values truncated to ${P.width} characters`);
  assert.strictEqual(f('mismatch', 'last_login_at').title, `last_login_at: ${P.shifted} values shifted by +${P.shiftHours} hours`);
  assert.strictEqual(f('mismatch', 'phone').title, 'phone: 1 null became an empty string');
  assert.deepStrictEqual(f('mismatch', 'phone').examples.map((e) => e.key), [String(P.emptied)]);
  assert.strictEqual(res.headline, '5 problems in 2,000 rows');
  assert.deepStrictEqual([res.rows.before, res.rows.after], [2000, 1998]);
  // Like for like, only the changed columns disagree.
  const bad = res.likeForLike.filter((c) => !c.ok).map((c) => c.column).sort();
  assert.ok(bad.includes('company_name') && bad.includes('phone'), bad.join());
  assert.ok(bad.every((c) => ['company_name', 'phone', 'last_login_at'].includes(c)), `like-for-like: ${bad.join()}`);
  assert.ok(res.findings.length > 0 && f('mismatch', 'company_name').examples.length === 20, '20 examples at most');
});

/* ---------------- the streaming worker, in Node ---------------- */

async function runWorker(files, fn) {
  const posted = [];
  const listeners = [];
  const saved = { self: global.self, importScripts: global.importScripts };
  global.self = { postMessage: (m) => posted.push(m), addEventListener: (t, f) => listeners.push(f) };
  global.importScripts = () => { global.self.ParityCore = C; };
  delete require.cache[require.resolve('../public/parse-worker.js')];
  require('../public/parse-worker.js');
  let id = 0;
  const call = (msg) => new Promise((resolve, reject) => {
    const my = ++id;
    const start = posted.length;
    listeners.forEach((f) => f({ data: { ...msg, id: my } }));
    const t = setInterval(() => {
      const m = posted.slice(start).find((x) => x.id === my);
      if (!m) return;
      clearInterval(t);
      if (m.op === 'done') resolve(m.result); else reject(new Error(m.message || m.op));
    }, 5);
  });
  try { return await fn(call, posted); } finally { global.self = saved.self; global.importScripts = saved.importScripts; }
}
test('the worker streams files (chunked, held in memory or read again per pass) to the same verdict as the core', async () => {
  const { d, recipe, res } = demo();
  const before = new File([d.before.text], d.before.name), after = new File([d.after.text], d.after.name);
  const rec = { pairs: recipe.pairs.map((p) => ({ from: p.from, to: p.to, sep: p.sep, rules: p.rules })), key: recipe.key };
  const sig = (r) => r.findings.map((f) => [f.kind, f.column, f.rows, (f.examples || []).map((e) => e.key).join()].join(':')).join('|');
  const keepLimit = C.LIMITS.memoryBytes;
  for (const limit of [keepLimit, 0]) {
    C.LIMITS.memoryBytes = limit;
    try {
      await runWorker(null, async (call, posted) => {
        const lb = await call({ op: 'load', side: 'before', file: before });
        const la = await call({ op: 'load', side: 'after', file: after });
        assert.strictEqual(lb.kept, limit > 0);
        assert.deepStrictEqual([lb.rows, la.rows, lb.format, la.format, lb.header], [2000, 1998, 'csv', 'jsonl', true]);
        assert.ok(posted.some((m) => m.op === 'progress' && m.phase === 'reading'), 'progress is reported');
        const learned = await call({ op: 'learn', recipe: { pairs: rec.pairs.map((p) => ({ ...p, rules: [] })), key: rec.key } });
        assert.strictEqual(learned.learned.length, 6);
        const r = await call({ op: 'compare', recipe: rec });
        assert.strictEqual(sig(r), sig(res), limit ? 'held in memory' : 'read again for each pass');
        assert.deepStrictEqual(r.files.before, { name: 'customers_before.csv', size: before.size, rows: 2000, format: 'csv' });
      });
    } finally { C.LIMITS.memoryBytes = keepLimit; }
  }
});

/* ---------------- fingerprints ---------------- */

test('SipHash-2-4 matches the reference vectors', () => {
  const hex = (h) => h.map((x) => x.toString(16).padStart(8, '0')).join('');
  const msg = (n) => Array.from({ length: n }, (_, i) => i);
  assert.strictEqual(hex(C.sipHash(KEY, msg(0))), '726fdb47dd0e0e31');
  assert.strictEqual(hex(C.sipHash(KEY, msg(1))), '74f839c593dc67fd');
  assert.strictEqual(hex(C.sipHash(KEY, msg(8))), '93f5f5799a932462');
  assert.strictEqual(hex(C.sipHash(KEY, msg(15))), 'a129ca6149be45e5');
  assert.strictEqual(hex(C.sipHash(KEY, msg(63))), '958a324ceb064572');
});

function fpOf(rows, plan, side, key, opts) { const h = C.createHasher(plan, side); rows.forEach(h.add); return { h: h.finish(), fp: C.fingerprintFrom(h.finish(), plan, side, key, Object.assign({ at: 'T' }, opts)) }; }
test('a fingerprint holds no value from the data by default; sums, minimums and maximums only when asked', () => {
  const { b, a, plan } = demo();
  const values = new Set();
  [b, a].forEach((t) => t.rows.forEach((r) => r.forEach((v) => { if (v !== null && v.trim().length >= 3) values.add(v.trim()); })));
  const fpA = fpOf(a.rows, plan, 'after', KEY).fp, fpB = fpOf(b.rows, plan, 'before', KEY).fp;
  for (const fp of [fpA, fpB]) {
    const json = JSON.stringify(fp);
    const leaked = [...values].filter((v) => !/^[0-9a-f]+$/i.test(v) && json.includes(v));
    assert.deepStrictEqual(leaked, [], 'no text, date or code value appears');
    // Numbers: ids are 5 digits; a 5-digit run could only come from a hash or a count.
    for (const t of [b, a]) t.rows.forEach((r) => { const id = r[0]; assert.ok(!new RegExp(`(^|[^0-9a-f])${id}([^0-9a-f]|$)`).test(json), `id ${id}`); });
    assert.strictEqual(fp.includesValues, false);
    fp.aggregates.forEach((x) => { assert.strictEqual(x.sum, undefined); assert.strictEqual(x.min, undefined); assert.strictEqual(x.max, undefined); });
  }
  const withVals = fpOf(a.rows, plan, 'after', KEY, { includeValues: true }).fp;
  const bal = withVals.aggregates.find((x) => x.column === 'balance');
  assert.ok(bal.sum && bal.min && bal.max, 'opt in: the values are there, and labelled');
  assert.strictEqual(withVals.includesValues, true);
  assert.ok(JSON.stringify(fpA).length < 150000, 'a small file');
});
test('salted: another passphrase changes every hash; equal data -> equal fingerprints; one changed row -> one bucket', async () => {
  const { b, a, plan } = demo();
  const k1 = await C.deriveKey('correct horse battery staple');
  const k2 = await C.deriveKey('correct horse battery staplf');
  assert.strictEqual(k1.length, 4);
  assert.deepStrictEqual(await C.deriveKey('  correct horse battery staple '), k1, 'spaces at the ends do not matter');
  const f1 = fpOf(a.rows, plan, 'after', k1).fp, f2 = fpOf(a.rows, plan, 'after', k2).fp;
  assert.notStrictEqual(f1.check, f2.check);
  const sameBuckets = f1.buckets.filter((x, i) => x && x === f2.buckets[i]).length;
  assert.strictEqual(sameBuckets, 0, 'no bucket hash survives a different passphrase');
  assert.match(C.compareFingerprints(fpOf(b.rows, plan, 'before', k1).fp, f2).error, /different passphrases/);
  // Equal inputs: before reshaped by the recipe equals after on every matching row.
  const fixed = a.rows.slice();
  const eq = fpOf(fixed, plan, 'after', k1).fp;
  assert.deepStrictEqual(eq, f1);
  // One changed value in one row: exactly one bucket differs, and Find rows names the key.
  const changed = fixed.map((r) => r.slice());
  const ci = changed.findIndex((r) => r[0] === '10500');
  changed[ci][10] = changed[ci][10] === 'US' ? 'CA' : 'US';
  const H1 = fpOf(fixed, plan, 'after', k1), H2 = fpOf(changed, plan, 'after', k1);
  const before1 = Object.assign({}, H1.fp, { side: 'before' });
  const cmp = C.compareFingerprints(before1, H2.fp);
  assert.strictEqual(cmp.ok, false);
  assert.strictEqual(cmp.buckets.differ.length, 1);
  const buckets = cmp.buckets.differ.map((x) => x.bucket);
  const l1 = C.rowListFrom(H1.h, plan, 'before', k1, buckets, { at: 'T' });
  const l2 = C.rowListFrom(H2.h, plan, 'after', k1, buckets, { at: 'T' });
  assert.ok(l1.rows.length > 0 && l1.rows.length < 10, `a handful of rows: ${l1.rows.length}`);
  const rc = C.compareRowLists(C.cleanRowList(JSON.parse(JSON.stringify(l1))), C.cleanRowList(JSON.parse(JSON.stringify(l2))));
  assert.deepStrictEqual(rc.differ.map((x) => x.status), ['differs']);
  assert.strictEqual(rc.differ[0].k, C.keyedKeyHex(k1, C.keyHashOf(plan, 'after', changed[ci])), 'the differing row is the changed one');
  assert.ok(!JSON.stringify(l1).includes('10500'), 'the row list holds no key value unless asked');
  const withKeys = C.rowListFrom(H1.h, plan, 'before', k1, buckets, { keys: new Map([[C.keyHashOf(plan, 'after', changed[ci]), '10500']]) });
  assert.ok(withKeys.rows.some((r) => r.key === '10500'));
});
test('fingerprints of the example: before against after narrows to the planted rows', () => {
  const { b, a, plan, d } = demo();
  const B = fpOf(b.rows, plan, 'before', KEY), A = fpOf(a.rows, plan, 'after', KEY);
  const cmp = C.compareFingerprints(C.cleanFingerprint(JSON.parse(JSON.stringify(A.fp))), C.cleanFingerprint(JSON.parse(JSON.stringify(B.fp))));
  assert.deepStrictEqual(cmp.rows, { before: 2000, after: 1998 });
  assert.ok(cmp.buckets.differ.length > 0 && cmp.buckets.differ.length < 500);
  const buckets = cmp.buckets.differ.map((x) => x.bucket);
  const rc = C.compareRowLists(C.rowListFrom(B.h, plan, 'before', KEY, buckets), C.rowListFrom(A.h, plan, 'after', KEY, buckets));
  const count = (s) => rc.differ.filter((x) => x.status === s).length;
  assert.deepStrictEqual([count('missing'), count('extra'), count('dupkey')], [3, 0, 1]);
  const { res } = demo();
  assert.strictEqual(count('differs'), res.differingKeys - 3 - 1, 'every changed row, once (a row changed in two columns counts once)');
  assert.ok(count('differs') >= Math.max(d.planted.truncated, d.planted.shifted));
  assert.strictEqual(C.cleanFingerprint({ ...A.fp, buckets: A.fp.buckets.slice(1) }), null, 'a fingerprint with the wrong number of buckets is refused');
  assert.strictEqual(C.cleanFingerprint({ ...A.fp, buckets: A.fp.buckets.map((x, i) => (i ? x : '<b>')) }), null);
});
/* ---------------- exports ---------------- */

const HOSTILE = '<img src=x onerror=alert(1)>\u202e"=cmd|\'/c calc\'!A1';
function hostileResult() {
  const cols = ['id', HOSTILE, 'n'];
  const b = table(cols, [{ id: '=HYPERLINK("http://x")', [HOSTILE]: '<script>alert(1)</script>', n: '-12.50' }, { id: '2', [HOSTILE]: '@SUM(A1)', n: '1' }]);
  const a = table(cols, [{ id: '=HYPERLINK("http://x")', [HOSTILE]: '</code><b>x</b>|`', n: '-12.5' }]);
  return compareTables(b, a, { pairs: [one('id'), one(HOSTILE), one('n')], key: ['id'] });
}
test('CSV export: formula-looking cells get an apostrophe, plain numbers stay numbers, quoting per RFC 4180', () => {
  assert.strictEqual(C.csvCell('=1+1'), "'=1+1");
  assert.strictEqual(C.csvCell('+cmd'), "'+cmd");
  assert.strictEqual(C.csvCell('-x'), "'-x");
  assert.strictEqual(C.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.strictEqual(C.csvCell('\tx'), "'\tx");
  assert.strictEqual(C.csvCell('-12.50'), '-12.50');
  assert.strictEqual(C.csvCell('a,"b"'), '"a,""b"""');
  const csv = C.examplesCsv(hostileResult());
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(!/(^|,)[=+@]/m.test(csv.replace(/^\ufeff/, '')), 'no cell starts a formula');
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`));
  assert.ok(!csv.includes('\u202e'), 'no bidi override');
});
test('HTML report: self-contained (no script, no external asset, a CSP that forbids both) and every string escaped', () => {
  const html = C.toHtml(hostileResult());
  assert.ok(!/<script/i.test(html) && !/<img/i.test(html) && !/<b>x/.test(html), 'no live markup from the data');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/\s(src|href)=["']?(https?:)?\/\//i.test(html), 'no external asset');
  assert.ok(html.includes("default-src 'none'; style-src 'unsafe-inline'"));
  assert.ok(!html.includes('\u202e'));
  const md = C.toMarkdown(hostileResult());
  const outside = md.replace(/(`+) .*? \1(?!`)/g, '');
  assert.ok(!/[<>]/.test(outside), 'outside code spans, no < or > in Markdown');
  assert.ok(!md.includes('\u202e'));
  const json = C.toJson(hostileResult());
  assert.strictEqual(json.parity, 'result');
});
test('summary only: no example, key value, sum, minimum, maximum or value-map entry', () => {
  const { res } = demo();
  for (const out of [JSON.stringify(C.toJson(res, { summaryOnly: true })), C.toMarkdown(res, { summaryOnly: true }), C.toHtml(res, { summaryOnly: true })]) {
    for (const v of ['10457', '10777', 'suspended', 'Coffee Roasters', '(555)', '@example']) assert.ok(!out.includes(v), `${v} leaked into a summary-only report`);
  }
  const full = C.toMarkdown(res);
  assert.ok(full.includes('10457') && full.includes('Coffee Roasters'), 'the full report does carry examples');
  const j = C.toJson(res, { summaryOnly: true });
  assert.ok(j.findings.every((f) => f.examples === undefined));
  assert.ok(j.likeForLike.every((c) => c.checks.every((x) => !['sum', 'min', 'max'].includes(x.metric))));
  assert.strictEqual(j.summaryOnly, true);
});
test('a recipe round-trips: names, rules, key and the after side\'s types - no rows', () => {
  const { recipe, pb, pa } = demo();
  const r = C.toRecipe(recipe, pa.columns);
  const back = C.cleanRecipe(JSON.parse(JSON.stringify(r)), pb.columns.map((c) => c.name), pa.columns.map((c) => c.name));
  assert.strictEqual(back.dropped, 0);
  assert.deepStrictEqual(back.recipe.pairs, r.pairs);
  assert.deepStrictEqual(back.recipe.key, ['customer_id']);
  assert.deepStrictEqual(r.target.find((c) => c.name === 'last_login_at'), { name: 'last_login_at', type: 'datetime', format: 'YYYY-MM-DDTHH:mm:ssZ' });
  assert.strictEqual(C.recipeId(r), C.recipeId(JSON.parse(JSON.stringify(r))));
});

/* ---------------- the model's input and output ---------------- */

test('the model summary is names, types and counts - no value from either table', () => {
  const { b, a, pb, pa } = demo();
  const s = JSON.stringify(C.modelSummary(pb, pa));
  const values = new Set();
  [b, a].forEach((t) => t.rows.forEach((r) => r.forEach((v) => { if (v && v.length >= 3) values.add(v); })));
  const leaked = [...values].filter((v) => s.includes(`"${v}"`) || (v.length >= 5 && s.includes(v)));
  assert.deepStrictEqual(leaked, []);
  assert.ok(s.includes('balance_cents') && s.includes('MM/DD/YYYY'));
});
test('a proposal is checked against the real names and the fixed rules', () => {
  const p = C.cleanProposal({ pairs: [{ from: ['a'], to: ['A'], rules: [{ rule: 'trim' }, { rule: 'eval' }], why: '<b>same</b>' }, { from: ['zz'], to: ['A'] }], key: ['A', '<x>'] }, ['a'], ['A']);
  assert.deepStrictEqual(p.pairs, [{ from: ['a'], to: ['A'], rules: [{ rule: 'trim' }], why: 'bsame/b' }]);
  assert.deepStrictEqual(p.key, ['A']);
  assert.strictEqual(p.dropped, 1);
  assert.strictEqual(C.cleanProposal({ pairs: [{ from: ['x'], to: ['y'] }] }, ['a'], ['A']), null);
});

/* ---------------- performance ---------------- */

test('200,000 rows compared in the core (no worker) in reasonable time', () => {
  const N = 200000;
  const mk = (i, shift) => [String(100000 + i), 'Name ' + (i % 997), String((i * 37) % 100000), '2024-0' + (1 + (i % 9)) + '-1' + (i % 10) + ' 10:00:00', i % 3 ? 'A' : 'I'];
  const bRows = [], aRows = [];
  for (let i = 0; i < N; i++) {
    bRows.push(mk(i));
    if (i === 77) continue;
    const r = mk(i);
    aRows.push([r[0], r[1].toUpperCase() === r[1] ? r[1] : r[1], (Number(r[2]) / 100).toFixed(2), r[3].replace(' ', 'T') + 'Z', r[4] === 'A' ? 'active' : 'inactive']);
  }
  aRows[5][1] = 'Changed';
  const bc = [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }, { name: 'cents', type: 'int' }, { name: 'ts', type: 'datetime', format: 'YYYY-MM-DD HH:mm:ss' }, { name: 'st', type: 'text' }];
  const ac = [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }, { name: 'amt', type: 'decimal' }, { name: 'ts', type: 'datetime', format: 'YYYY-MM-DDTHH:mm:ssZ' }, { name: 'st', type: 'text' }];
  const plan = C.compilePlan({ pairs: [one('id'), one('name'), one('cents', 'amt', [{ rule: 'scale', op: 'div100' }]), one('ts', 'ts', [{ rule: 'date', from: 'YYYY-MM-DD HH:mm:ss', to: 'YYYY-MM-DDTHH:mm:ssZ' }]), one('st', 'st', [{ rule: 'map', table: [['A', 'active'], ['I', 'inactive']] }])], key: ['id'] }, bc, ac);
  const t0 = Date.now();
  const res = C.compareRows(bRows, aRows, plan, { at: 'T' });
  const ms = Date.now() - t0;
  console.log(`       (200,000 rows x 5 columns, both sides: ${ms} ms)`);
  assert.deepStrictEqual(res.findings.map((f) => [f.kind, f.rows]).sort(), [['mismatch', 1], ['missing', 1]]);
  assert.ok(ms < 20000, `${ms} ms`);
});

/* ---------------- the page ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test('every text colour holds 4.5:1 on its surface in both themes; marks 3:1', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'code-bg']) for (const fg of ['text', 'muted', 'link', 'err', 'good', 'bad']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const [fg, bg] of [['text', 'accent-soft'], ['link', 'accent-soft'], ['accent-ink', 'accent'], ['good', 'good-bg'], ['text', 'good-bg'], ['muted', 'good-bg'], ['bad', 'bad-bg'], ['text', 'bad-bg'], ['muted', 'bad-bg'], ['warn', 'warn-bg'], ['text', 'warn-bg'], ['strip-ink', 'strip'], ['strip-muted', 'strip'], ['bg', 'text']]) {
      assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    }
    for (const m of ['b-same', 'b-diff', 'accent']) assert.ok(ratio(t[m], t.card) >= 3, `${name} ${m} mark: ${ratio(t[m], t.card).toFixed(2)}`);
  }
  // The hero is fixed colours.
  for (const [fg, bg] of [['#ffffff', '#0b2a33'], ['#d5efec', '#0b3b45'], ['#d5efec', '#0d5560'], ['#9ff0e4', '#0b2a33'], ['#052a27', '#9ff0e4'], ['#ffffff', '#0d5560']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}`);
  assert.ok(/min-height: 44px/.test(css), '44px tap targets');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, only known requests, nothing after a response', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|message) =/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...js.matchAll(/api\('(GET|POST)', '([^']+)'/g)].map((m) => m[2]);
  assert.deepStrictEqual([...new Set(calls)].sort(), ['api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/suggest'], 'the page asks for nothing else - no route takes a row');
  assert.ok(/api\('POST', 'api\/suggest', \{ summary: summary \}\)/.test(js), 'the suggestion sends the summary it showed, and only that');
  assert.ok(/summary = C\.modelSummary\(/.test(js));
  assert.ok(js.includes("new Worker('parse-worker.js')") && js.includes("register('sw.js', { scope: './' })"), 'the worker and service worker are relative');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js + fs.readFileSync(path.join(ROOT, 'public', 'demo.js'), 'utf8')), 'no email address in the page or the example source');
  const worker = fs.readFileSync(path.join(ROOT, 'public', 'parse-worker.js'), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(worker + fs.readFileSync(path.join(ROOT, 'public', 'parity-core.js'), 'utf8')), 'the reader and the rules never make a request');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/setInterval|setTimeout/.test(server), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|summary|request|raw)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} logs a body`);
});

test('the service worker: the app\'s own files under its own scope, never api/, only parity-* caches', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return/.test(sw), 'api/ is never answered from a cache');
  assert.ok(/url\.origin !== self\.location\.origin\) return/.test(sw));
  assert.ok(/url\.pathname\.indexOf\(scope\) !== 0\) return/.test(sw), 'nothing outside the app');
  assert.ok(/k\.indexOf\('parity-'\) === 0 && k !== CACHE/.test(sw), 'only its own old caches are deleted');
  const shell = JSON.parse(/var SHELL = (\[[^\]]*\])/.exec(sw)[1].replace(/'/g, '"'));
  for (const f of shell.filter((x) => x !== './')) assert.ok(fs.existsSync(path.join(ROOT, 'public', f)), `${f} is cached but missing`);
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  for (const [, f] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) assert.ok(shell.includes(f), `${f} is loaded but not cached for offline`);
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { PARITY_MEMORY: '1' }], ['./lib/fakeai', { PARITY_FAKE_AI: '1' }], ['./server', { PARITY_FAKE_AI: '1', PARITY_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, PARITY_MEMORY: '', PARITY_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

/* ---------------- over HTTP ---------------- */

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
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { text }; }
    return { status: res.status, data, text, headers: res.headers };
  };
}
async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const demoSummary = () => { const { pb, pa } = demo(); return C.modelSummary(pb, pa); };
const BIG = { summary: { pad: 'x'.repeat(70 * 1024) } };

test('signed out: the page and its workers load, zero model calls; the suggest route answers 401 before reading any body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual(meta.rules.map((r) => r.id), C.RULE_IDS);
  for (const f of ['parity-core.js', 'demo.js', 'app.js', 'app.css', 'parse-worker.js', 'sw.js', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const sw = await fetch(`${base}/sw.js`);
  assert.strictEqual(sw.headers.get('cache-control'), 'no-cache', 'the service worker is re-checked every load');
  assert.match(sw.headers.get('content-type'), /javascript/);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.ok(!/worker-src|unsafe/.test(page.headers.get('content-security-policy')), 'workers run under script-src \'self\' - nothing loosened');
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/suggest', { summary: demoSummary() })).status, 401);
  assert.strictEqual((await anon('POST', '/api/suggest', BIG)).status, 401, 'the gate answers before the parser, so not 413');
  for (const p of ['/api/upload', '/api/compare', '/api/rows', '/api/fingerprint']) assert.strictEqual((await anon('POST', p, { rows: [['x']] })).status, 404, `${p}: there is no route for data`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route: requireUser, requireBudget, requireDailyCap, THEN its parser; one model call in the server', () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/api/suggest' && l.route.methods.post);
  assert.deepStrictEqual(layer.route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one metered call, nowhere else');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('suggest: input checked before any spend, one metered call, only names/types/counts reach the model, the answer checked', async () => {
  const ana = await register('ana.lead@example.com');
  const calls = await modelCalls();
  assert.strictEqual((await ana('POST', '/api/suggest', {})).status, 400);
  assert.strictEqual((await ana('POST', '/api/suggest', { summary: { before: { columns: [] }, after: { columns: [{ name: 'a' }] } } })).status, 400);
  assert.strictEqual((await ana('POST', '/api/suggest', BIG)).status, 413, 'over the 64 KB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const sent = demoSummary();
  sent.before.columns[1].sample = ['VALUE_MARKER_Ann Lee'];
  sent.before.columns[2].values = 'VALUE_MARKER_2';
  sent.after.rowsData = [['VALUE_MARKER_3']];
  sent.before.columns[0].type = '<script>';
  const n0 = fakeCalls.length;
  const r = await ana('POST', '/api/suggest', { summary: sent });
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(r.data.proposal.pairs.length >= 8);
  assert.deepStrictEqual(r.data.proposal.key, ['customer_id']);
  const split = r.data.proposal.pairs.find((p) => p.from[0] === 'full_name');
  assert.deepStrictEqual(split.to, ['first_name', 'last_name']);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  assert.strictEqual(fakeCalls.length, n0 + 1);
  const req = fakeCalls[fakeCalls.length - 1];
  assert.strictEqual(req.model, 'claude-haiku-4-5', 'a free account runs Haiku');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'propose_mapping' });
  const body = JSON.stringify(req.messages);
  for (const m of ['VALUE_MARKER', 'sample', 'values', 'rowsData', '<script>']) assert.ok(!body.includes(m), `${m} reached the model`);
  const { b, a } = demo();
  const vals = new Set(); [b, a].forEach((t) => t.rows.slice(0, 200).forEach((row) => row.forEach((v) => { if (v && v.length >= 5 && !/^\d+$/.test(v)) vals.add(v); })));
  assert.deepStrictEqual([...vals].filter((v) => body.includes(v)), [], 'no value from the tables');
  assert.ok(body.includes('balance_cents'), 'column names do');
  assert.strictEqual(JSON.stringify(r.data.sent), JSON.stringify(ai.cleanRequest(sent)), 'the answer says exactly what was sent');
  // Hostile and failing answers.
  const withName = (name) => { const s = demoSummary(); s.before.columns[0] = { ...s.before.columns[0], name }; return { summary: s }; };
  const inj = await ana('POST', '/api/suggest', withName('INJECT_id'));
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.deepStrictEqual(inj.data.proposal.pairs.map((p) => p.rules), [[{ rule: 'trim' }]], 'unknown columns and made-up rules are dropped');
  assert.ok(inj.data.proposal.pairs[0].why.length <= 200);
  const blank = await ana('POST', '/api/suggest', withName('BLANK'));
  assert.deepStrictEqual([blank.status, /nothing usable/.test(blank.data.error)], [422, true]);
  assert.match((await ana('POST', '/api/suggest', withName('MAXTOKENS'))).data.error, /ran long/);
  const up = await ana('POST', '/api/suggest', withName('UPSTREAM401'));
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await ana('POST', '/api/suggest', withName('UPSTREAM529'));
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('an unconfirmed free account gets the verify-email 403 before any model call or big body; out of credit is a 402, not a 413', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/suggest', { summary: demoSummary() });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/parity/api/auth/verify/send', 'the resend link is under this app\'s mount');
    assert.strictEqual((await eve('POST', '/api/suggest', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/suggest', { summary: demoSummary() })).status, 402);
  assert.strictEqual((await cal('POST', '/api/suggest', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

test('nothing is stored server-side: no shape, mapping or answer - only the shared account and its usage rows', async () => {
  const dump = identityStore._dump();
  for (const m of ['balance_cents', 'propose_mapping', 'customer_id', 'VALUE_MARKER', 'first_name']) assert.ok(!dump.includes(m), `${m} was stored`);
  const cols = JSON.parse(dump).map(([p]) => p).sort();
  assert.ok(cols.every((c) => ['users', 'usage', 'events', 'control'].some((k) => c.toLowerCase().includes(k))), `only account collections: ${cols.join(', ')}`);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/store\.(set|merge|add|transact)\(/.test(src), 'the server has no app store to write to');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/parity', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/parity`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
