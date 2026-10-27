// Pure rules first (the tokenizer and parser on many shapes, resolution,
// equivalent filter forms, every check with its match / missing / different
// cases, fan-out, the BETWEEN trap, question matching, the fix, exports and
// import), then the page's own promises, then end to end against the memory
// store and the fake model:
//   CANON_MEMORY=1 CANON_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /canon, the way the
// lab mounts it, so the auth cookie, the budget gate and each route's parser
// order are exercised as deployed. Model calls are counted from the identity
// usage rows, and what reached "the model" is read from the fake's own log.
//
// Every canon, question and query here is made up.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.CANON_MEMORY !== '1' || process.env.CANON_FAKE_AI !== '1') {
  console.error('run with CANON_MEMORY=1 CANON_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag, shareId } = require('../server');
const C = require('../public/canon-core');
const D = require('../public/demo');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const TODAY = '2026-10-27';

/* ---------------- helpers ---------------- */

const CANON = () => C.cleanCanon(D.canon());
const check = (question, sql, opts) => C.analyze({ question, sql }, (opts && opts.canon) || CANON(), Object.assign({ today: TODAY }, opts || {}));
const metricOf = (r, id) => r.metrics.find((m) => m.id === id) || r.metrics[0];
const row = (r, key, id) => { const m = metricOf(r, id); return m && m.checks.find((c) => c.key === key || c.key.startsWith(key)); };
const verdict = (r, key, id) => { const c = row(r, key, id); return c ? c.verdict : 'absent'; };
const filterRow = (r, frag, id) => metricOf(r, id).checks.find((c) => c.key.startsWith('filter:') && c.key.includes(frag));
const parse = (sql, canon) => C.parseSql(sql, canon === undefined ? CANON() : canon);
const sels = (A) => A.selects;
const conds = (A, sel) => C.conjuncts(A, sel.where.s, sel.where.e).map((c) => C.predicate(A, sel, c.s, c.e));
const pred = (cond, canon) => { const A = parse(`SELECT 1 FROM orders o WHERE ${cond}`, canon); const s = A.root.selects[0]; return C.predicate(A, s, s.where.s, s.where.e); };
const eq = (want, got) => C.equivalent(pred(want), pred(got));
// A revenue query that is right in every way, to vary one thing at a time.
const GOOD_REV = (where, extra = {}) => `SELECT ${extra.select || 'SUM(ol.net_amount) AS revenue'}
FROM order_lines ol
JOIN orders o ON o.id = ol.order_id${extra.join || ''}
WHERE ${where || "o.status = 'paid' AND o.is_test = false AND ol.refunded_at IS NULL"}
  AND o.paid_at AT TIME ZONE 'America/New_York' >= '2026-07-01'
  AND o.paid_at AT TIME ZONE 'America/New_York' < '2026-10-01'${extra.tail || ''}`;

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/* ================================================================== *
 * The tokenizer
 * ================================================================== */

test('tokenizer: comments of every kind, quoted identifiers in four dialects, strings, dollar quotes, templates, parameters, operators', () => {
  const tk = C.tokenize(`-- a line comment with 'quotes' and SELECT
/* a block /* nested */ comment */ SELECT "Order Lines"."Net Amount", \`proj.ds.orders\`.id, [dbo].[Orders].[Total], 'it''s', E'it\\'s', $$dollar 'quoted'$$, $tag$x$tag$,
  {{ ref('orders') }}, {% if x %}, $1, :start_date, @tenant, ?, x::date, a <> b, a != b, a || b, 1.5e3, .5, #temp # mysql comment
FROM t`);
  const T = tk.tokens;
  assert.ok(!T.some((t) => /line comment|nested|mysql comment/.test(t.v)), 'comments are dropped');
  assert.strictEqual(tk.comments.length, 3);
  const q = T.filter((t) => t.t === 'qident').map((t) => t.n);
  assert.deepStrictEqual(q, ['Order Lines', 'Net Amount', 'proj.ds.orders', 'dbo', 'Orders', 'Total']);
  const strs = T.filter((t) => t.t === 'string').map((t) => t.n);
  assert.deepStrictEqual(strs, ["it's", "it's", "dollar 'quoted'", 'x']);
  assert.deepStrictEqual(T.filter((t) => t.t === 'template').map((t) => t.n), ["ref('orders')", 'if x']);
  assert.deepStrictEqual(T.filter((t) => t.t === 'param').map((t) => t.v), ['$1', ':start_date', '@tenant', '?']);
  assert.deepStrictEqual(T.filter((t) => t.t === 'op').map((t) => t.v).filter((v) => v !== '.'), ['::', '<>', '!=', '||']);
  assert.deepStrictEqual(T.filter((t) => t.t === 'number').map((t) => t.n), [1500, 0.5]);
  assert.ok(T.some((t) => t.t === 'word' && t.n === '#temp'), 'a T-SQL temp table is a name');
  assert.deepStrictEqual(tk.problems, []);
  // BigQuery: backslash escapes and triple quotes; an unterminated string is noted, not thrown
  assert.deepStrictEqual(C.tokenize("WHERE name = 'O\\'Brien' AND note = '''multi\nline'''").tokens.filter((t) => t.t === 'string').map((t) => t.n), ["O'Brien", 'multi\nline']);
  assert.deepStrictEqual(C.tokenize("SELECT 'never closes").problems, ['string']);
  assert.deepStrictEqual(C.tokenize('SELECT 1 /* open').problems, ['comment']);
  // subscripts are not bracketed names
  assert.ok(!C.tokenize('SELECT arr[1] FROM t').tokens.some((t) => t.t === 'qident'));
});

/* ================================================================== *
 * The parser
 * ================================================================== */

test('parser: CTEs (several, recursive, column lists, MATERIALIZED), derived tables, nested joins, UNION branches and subqueries', () => {
  const A = parse(`WITH RECURSIVE a(x) AS MATERIALIZED (SELECT id FROM orders), b AS (SELECT * FROM a WHERE x > 1)
    SELECT b.x, t.n FROM b JOIN (SELECT order_id, COUNT(*) AS n FROM order_lines GROUP BY order_id) t ON t.order_id = b.x
    LEFT JOIN (customers c JOIN orders o2 ON o2.customer_id = c.id) ON o2.id = b.x
    WHERE b.x IN (SELECT id FROM orders WHERE is_test) AND EXISTS (SELECT 1 FROM products)
    UNION ALL SELECT id, 0 FROM orders ORDER BY 1`);
  assert.deepStrictEqual(A.root.ctes.map((c) => c.key), ['a', 'b']);
  assert.strictEqual(A.root.selects.length, 2, 'two UNION branches');
  const main = A.root.selects[0];
  assert.deepStrictEqual(main.flat.map((s) => `${s.kind}:${s.key || s.alias}:${s.join}${s.optional ? '?' : ''}`), ['cte:b:from', 'derived:t:inner', 'table:customers:left?', 'table:orders:inner']);
  assert.strictEqual(main.flat[0].query.selects[0].flat[0].kind, 'cte', 'b reads a, bound to its body');
  assert.strictEqual(main.subs.length, 2, 'two subqueries in WHERE');
  assert.deepStrictEqual(A.feed.scans.map((s) => s.src.key).sort(), ['customers', 'order_lines', 'orders', 'orders', 'orders'], 'every FROM-reachable scan: in a, t, the nested group, and the second branch');
  assert.ok(!A.feed.scans.some((s) => s.src.key === 'products'), 'a WHERE subquery is not a scan that feeds the result');
});

test('parser: clause edges - IS DISTINCT FROM, EXTRACT(x FROM y), CASE with AND, BETWEEN AND, TOP, DISTINCT ON, GROUP BY position / alias / ROLLUP / ALL, LATERAL, USING', () => {
  let A = parse("SELECT TOP 10 o.id FROM orders o WHERE o.status IS DISTINCT FROM 'x' AND EXTRACT(YEAR FROM o.paid_at) = 2026 AND CASE WHEN a AND b THEN 1 END = 1 AND o.total BETWEEN 1 AND 5");
  const s = A.root.selects[0];
  assert.strictEqual(s.flat.length, 1, 'IS DISTINCT FROM and EXTRACT ... FROM are not a FROM clause');
  assert.strictEqual(C.conjuncts(A, s.where.s, s.where.e).length, 4, 'CASE ... AND and BETWEEN ... AND stay inside their conjunct');
  A = parse('SELECT DISTINCT ON (o.customer_id) o.channel AS ch, COUNT(*) FROM orders o GROUP BY ROLLUP(ch, 2)');
  assert.strictEqual(A.root.selects[0].groupBy.length, 2);
  assert.strictEqual(A.root.selects[0].items[0].aliasKey, 'ch');
  A = parse('SELECT o.channel, SUM(l.net_amount) FROM orders o JOIN order_lines l USING (order_id) CROSS JOIN LATERAL (SELECT 1) z GROUP BY ALL');
  assert.deepStrictEqual(A.root.selects[0].flat[1].using, ['order_id']);
  assert.ok(A.root.selects[0].groupAll);
  assert.strictEqual(A.root.selects[0].flat[2].kind, 'derived');
  // the statement with the aggregate is the one checked, and it says so
  A = parse('SET search_path = shop; SELECT 1; SELECT SUM(net_amount) FROM order_lines;');
  assert.strictEqual(A.root.selects[0].items[0].exprS > 0, true);
  assert.match(A.notes[0], /3 statements; Canon checked the one starting on line 1/);
});

test('parser: quoted and qualified names resolve - "Order Lines", `proj.ds.orders`, [dbo].[orders], schema.table and a bare table name', () => {
  const canon = CANON();
  for (const [sql, want] of [
    ['SELECT SUM("Ol"."net_amount") FROM "Shop"."Order_Lines" AS "Ol"', 'order_lines.net_amount'],
    ['SELECT SUM(ol.net_amount) FROM `proj.shop.order_lines` ol', 'order_lines.net_amount'],
    ['SELECT SUM([ol].[net_amount]) FROM [dbo].[order_lines] [ol]', 'order_lines.net_amount'],
    ['SELECT SUM(order_lines.net_amount) FROM analytics.order_lines', 'order_lines.net_amount'],
    ['SELECT SUM(net_amount) FROM order_lines JOIN orders ON orders.id = order_lines.order_id', 'order_lines.net_amount'],
  ]) {
    const r = C.analyze({ question: 'revenue', sql }, canon, { today: TODAY });
    assert.strictEqual(verdict(r, 'source'), 'match', `${sql}: ${row(r, 'source').why}`);
    assert.match(row(r, 'source').why, new RegExp(want.replace('.', '\\.')));
  }
});

test('resolution: through aliases, CTEs, SELECT *, derived tables and UNION branches to the base table', () => {
  const A = parse(`WITH base AS (SELECT o.*, o.paid_at AT TIME ZONE 'America/New_York' AS local_paid FROM orders o),
    lines AS (SELECT * FROM order_lines)
    SELECT SUM(l.net_amount) FROM lines l JOIN base b ON b.id = l.order_id WHERE b.status = 'paid' AND b.local_paid >= '2026-07-01'`);
  const s = A.root.selects[0];
  const r1 = C.resolve(A, s, ['l', 'net_amount']);
  assert.deepStrictEqual(r1.refs.map((x) => `${x.table}.${x.column}`), ['order_lines.net_amount']);
  const r2 = C.resolve(A, s, ['b', 'status']);
  assert.deepStrictEqual(r2.refs.map((x) => `${x.table}.${x.column}`), ['orders.status']);
  const r3 = C.resolve(A, s, ['b', 'local_paid']);
  assert.deepStrictEqual(r3.refs.map((x) => `${x.table}.${x.column}`), ['orders.paid_at']);
  assert.ok(r3.hops.length >= 1, 'the expression it passed through is kept (its time zone counts)');
  const U = parse('SELECT SUM(x) FROM (SELECT net_amount AS x FROM order_lines UNION ALL SELECT amount FROM refunds) u');
  assert.deepStrictEqual(C.resolve(U, U.root.selects[0], ['x']).refs.map((x) => `${x.table}.${x.column}`), ['order_lines.net_amount', 'refunds.amount'], 'a UNION column comes from every branch, by position');
  const amb = parse('SELECT SUM(net_amount) FROM order_lines a JOIN order_lines b ON a.id = b.id', null);
  assert.ok(C.resolve(amb, amb.root.selects[0], ['net_amount']).ambiguous, 'two candidates and no schema notes: ambiguous, never guessed');
});

/* ================================================================== *
 * Equivalent filter forms
 * ================================================================== */

test('equivalent forms: = false, IS FALSE, NOT x, <> true, != true and = 0 all match; the opposite never does', () => {
  for (const got of ['o.is_test = false', 'o.is_test IS FALSE', 'NOT o.is_test', 'o.is_test <> true', 'o.is_test != TRUE', 'o.is_test = 0', 'NOT (o.is_test = true)', '(NOT o.is_test)', 'false = o.is_test']) {
    assert.strictEqual(eq('orders.is_test = false', got).ok, true, got);
  }
  for (const got of ['o.is_test IS NOT TRUE', 'COALESCE(o.is_test, false) = false']) {
    const r = eq('orders.is_test = false', got);
    assert.ok(r.ok && /NULL/.test(r.note), `${got}: matches, with a note that NULLs are kept too`);
  }
  for (const got of ['o.is_test = true', 'o.is_test', 'o.is_test IS TRUE', 'NOT o.is_test = false', 'o.is_test <> false']) {
    const r = eq('orders.is_test = false', got);
    assert.ok(!r.ok && r.opposite, `${got} is the opposite`);
  }
  assert.strictEqual(eq('orders.is_test = false', "o.is_test = 'f'").ok, true, "'f' is a boolean false");
});

test('equivalent forms: values (=, IN, flipped, case), NULL tests and comparisons', () => {
  const ok = (w, g) => assert.strictEqual(eq(w, g).ok, true, `${w} vs ${g}: ${eq(w, g).why}`);
  const no = (w, g, re) => { const r = eq(w, g); assert.strictEqual(r.ok, false, `${w} vs ${g}`); if (re) assert.match(r.why, re); };
  ok("orders.status = 'paid'", "o.status = 'paid'");
  ok("orders.status = 'paid'", "'paid' = o.status");
  ok("orders.status = 'paid'", "o.status IN ('paid')");
  ok("orders.status = 'paid'", "LOWER(o.status) = 'PAID'");
  no("orders.status = 'paid'", "o.status = 'PAID'", /case/);
  no("orders.status = 'paid'", "o.status IN ('paid', 'refunded')", /lets in 'refunded'/);
  no("orders.status = 'paid'", "o.status = 'pending'", /keeps 'pending' instead of 'paid'/);
  no("orders.status IN ('paid', 'shipped')", "o.status = 'paid'", /leaves out 'shipped'/);
  no("orders.status = 'paid'", "o.status <> 'cancelled'", /not equal/);
  ok("orders.status NOT IN ('test')", "o.status <> 'test'");
  ok('order_lines.refunded_at IS NULL', 'refunded_at IS NULL');
  ok('order_lines.refunded_at IS NULL', 'NOT (refunded_at IS NOT NULL)');
  ok('order_lines.refunded_at IS NULL', 'refunded_at ISNULL');
  no('order_lines.refunded_at IS NULL', 'refunded_at IS NOT NULL', /opposite/);
  ok('order_lines.net_amount > 0', '0 < net_amount');
  ok('order_lines.net_amount > 0', 'net_amount >= 1');
  no('order_lines.net_amount > 0', 'net_amount >= 0', /different bound/);
  // a double-quoted string (MySQL, BigQuery) is a value when it is not a column
  ok("orders.status = 'paid'", 'o.status = "paid"');
});

/* ================================================================== *
 * The demo, end to end through the rules
 * ================================================================== */

test('the example: refunds and test orders counted (2 problems), a fan-out (1 problem), and the right one (matches)', () => {
  const [refunds, fanout, correct] = D.answers();
  const a = check(refunds.question, refunds.sql);
  assert.strictEqual(a.verdict.line, '2 problems: refunds included, test orders included');
  assert.deepStrictEqual(metricOf(a).checks.map((c) => `${c.key.split(':')[0]}=${c.verdict}`), ['source=match', 'aggregation=match', 'filter=match', 'filter=missing', 'filter=missing', 'date=match', 'timezone=match', 'range=match', 'grain=match']);
  assert.match(row(a, 'range').why, /exactly Q3 2026/);
  const b = check(fanout.question, fanout.sql);
  assert.strictEqual(b.verdict.line, '1 problem: double counting from the join to order_lines');
  assert.strictEqual(b.metrics[0].id, 'average-order-value', '"average order value" wins over "order"');
  assert.strictEqual(filterRow(b, 'is_test').verdict, 'match', 'NOT o.is_test is the canon\u2019s filter');
  assert.strictEqual(verdict(b, 'dimensions'), 'match');
  const c = check(correct.question, correct.sql);
  assert.strictEqual(c.verdict.kind, 'ok');
  assert.strictEqual(c.verdict.line, 'Matches the canon for Active customers');
  assert.strictEqual(c.metrics[0].checks.length, 9);
  assert.ok(c.metrics[0].checks.every((x) => x.verdict === 'match'));
  assert.strictEqual(c.fix, null, 'nothing to fix');
});

test('dialects: Snowflake, BigQuery (double-quoted dates and zones), MySQL, T-SQL, dbt refs and scalar subqueries all read as the right revenue', () => {
  const ok = (name, q, sql) => { const r = check(q, sql); assert.strictEqual(r.verdict.kind, 'ok', `${name}: ${r.verdict.line} | ${r.metrics.map((m) => m.checks.filter((c) => c.verdict !== 'match').map((c) => c.title + ': ' + c.why).join('; ')).join(' / ')}`); };
  ok('snowflake', 'revenue in Q3 2026', `SELECT SUM(OL.NET_AMOUNT) AS REVENUE FROM ANALYTICS.SHOP.ORDER_LINES OL JOIN ANALYTICS.SHOP.ORDERS O ON O.ID = OL.ORDER_ID
    WHERE O.STATUS = 'paid' AND O.IS_TEST = FALSE AND OL.REFUNDED_AT IS NULL
    AND CONVERT_TIMEZONE('America/New_York', O.PAID_AT) >= '2026-07-01' AND CONVERT_TIMEZONE('America/New_York', O.PAID_AT) < '2026-10-01'`);
  ok('bigquery', 'revenue in Q3 2026', 'SELECT SUM(ol.net_amount) FROM `proj.shop.order_lines` AS ol JOIN `proj.shop.orders` AS o ON o.id = ol.order_id\nWHERE o.status = "paid" AND NOT o.is_test AND ol.refunded_at IS NULL\n  AND DATE(o.paid_at, "America/New_York") BETWEEN "2026-07-01" AND "2026-09-30"');
  ok('bigquery trunc', 'revenue by month in Q3 2026', 'SELECT TIMESTAMP_TRUNC(o.paid_at, MONTH, "America/New_York") AS m, SUM(ol.net_amount) FROM `shop.order_lines` ol JOIN `shop.orders` o ON o.id = ol.order_id WHERE o.status = "paid" AND NOT o.is_test AND ol.refunded_at IS NULL AND DATE(o.paid_at, "America/New_York") >= "2026-07-01" AND DATE(o.paid_at, "America/New_York") < "2026-10-01" GROUP BY m');
  ok('mysql', 'revenue in Q3 2026', "SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND o.is_test = 0 AND ol.refunded_at IS NULL AND CONVERT_TZ(o.paid_at,'+00:00','America/New_York') >= '2026-07-01' AND CONVERT_TZ(o.paid_at,'+00:00','America/New_York') < '2026-10-01'");
  ok('t-sql', 'revenue in Q3 2026', "SELECT TOP 1 SUM([ol].[net_amount]) AS [Revenue] FROM [dbo].[order_lines] [ol] INNER JOIN [dbo].[orders] [o] ON [o].[id] = [ol].[order_id] WHERE [o].[status] = N'paid' AND [o].[is_test] = 0 AND [ol].[refunded_at] IS NULL AND ([o].[paid_at] AT TIME ZONE 'UTC' AT TIME ZONE 'Eastern Standard Time') >= '2026-07-01' AND ([o].[paid_at] AT TIME ZONE 'UTC' AT TIME ZONE 'Eastern Standard Time') < '2026-10-01'");
  ok('dbt', 'revenue in Q3 2026', "select sum(ol.net_amount) from {{ ref('order_lines') }} ol join {{ source('shop', 'orders') }} o on o.id = ol.order_id where o.status = 'paid' and not o.is_test and ol.refunded_at is null and convert_timezone('America/New_York', o.paid_at) >= '2026-07-01' and convert_timezone('America/New_York', o.paid_at) < '2026-10-01'");
  ok('zone on the bound', 'revenue in Q3 2026', "SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL AND o.paid_at >= TIMESTAMP '2026-07-01 00:00' AT TIME ZONE 'America/New_York' AND o.paid_at < TIMESTAMP '2026-10-01 00:00' AT TIME ZONE 'America/New_York'");
  ok('scalar subqueries', 'revenue and orders', "SELECT (SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL) AS revenue, (SELECT COUNT(*) FROM orders WHERE status = 'paid' AND NOT is_test) AS orders");
  ok('a ratio with NULLIF and CASE', 'refund rate in Q3 2026', "SELECT SUM(CASE WHEN ol.refunded_at IS NOT NULL THEN ol.net_amount END) / NULLIF(SUM(ol.net_amount), 0) AS refund_rate FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND o.is_test = false AND o.paid_at AT TIME ZONE 'America/New_York' >= '2026-07-01' AND o.paid_at AT TIME ZONE 'America/New_York' < '2026-10-01'");
  const parts = check('revenue in Q3 2026', "SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL AND EXTRACT(YEAR FROM o.paid_at) = 2026 AND EXTRACT(QUARTER FROM o.paid_at) = 3");
  assert.deepStrictEqual([verdict(parts, 'timezone'), verdict(parts, 'range')], ['missing', 'unsure'], 'date parts on a UTC timestamp: the zone is missing, the range is checked by hand');
  assert.strictEqual(C.tokenize('WHERE d = "2026-07-01" AND z = "America/New_York" AND s = "paid"').tokens.filter((t) => t.t === 'string').length, 2, 'only a double-quoted date or zone is assumed to be a string');
});

/* ================================================================== *
 * Each check
 * ================================================================== */

test('source: the defined column matches; another column is Different; an unqualified column with two candidates is Can\u2019t tell', () => {
  assert.strictEqual(verdict(check('revenue', GOOD_REV()), 'source'), 'match');
  const r = check('revenue', GOOD_REV(null, { select: 'SUM(o.total) AS revenue' }));
  assert.strictEqual(verdict(r, 'source'), 'different');
  assert.match(row(r, 'source').why, /orders\.total where the canon reads order_lines\.net_amount/);
  assert.match(r.verdict.line, /orders\.total instead of order_lines\.net_amount/);
  const noNotes = Object.assign(CANON(), { tables: [], relationships: [] });
  const u = check('revenue', 'SELECT SUM(net_amount) FROM order_lines a JOIN order_lines_archive b ON a.id = b.id', { canon: noNotes });
  assert.strictEqual(verdict(u, 'source'), 'unsure');
  const none = check('revenue', 'SELECT * FROM order_lines');
  assert.strictEqual(verdict(none, 'source'), 'different', 'no aggregate at all');
});

test('aggregation: SUM vs AVG is Different; a ratio answered with one AVG is Different; COUNT vs COUNT(DISTINCT) is left to the grain check', () => {
  const avg = check('revenue', GOOD_REV(null, { select: 'AVG(ol.net_amount) AS revenue' }));
  assert.strictEqual(verdict(avg, 'aggregation'), 'different');
  assert.match(avg.verdict.line, /AVG instead of SUM/);
  const aov = check('average order value', "SELECT AVG(o.total) FROM orders o WHERE o.status = 'paid' AND NOT o.is_test");
  assert.strictEqual(verdict(aov, 'aggregation'), 'different');
  assert.match(row(aov, 'aggregation').why, /divides two aggregates/);
  assert.strictEqual(verdict(aov, 'source'), 'different');
  const cnt = check('orders', "SELECT COUNT(o.id) FROM orders o WHERE o.status = 'paid' AND o.is_test = false");
  assert.strictEqual(verdict(cnt, 'aggregation'), 'match');
  assert.strictEqual(verdict(cnt, 'grain'), 'match', 'nothing joined, so COUNT(id) counts one per order here');
  assert.match(row(cnt, 'grain').why, /stays right if a join is added/);
});

test('filters: missing, matched in a CTE or a JOIN ON, different (opposite, wider, inside an OR), only in a subquery, a table never read', () => {
  const miss = check('revenue', GOOD_REV("o.status = 'paid' AND o.is_test = false"));
  assert.strictEqual(filterRow(miss, 'refunded_at').verdict, 'missing');
  assert.match(filterRow(miss, 'refunded_at').why, /refunds are counted/);
  const viaCte = check('revenue', `WITH real_orders AS (SELECT * FROM orders WHERE status = 'paid' AND NOT is_test)
    SELECT SUM(ol.net_amount) FROM order_lines ol JOIN real_orders r ON r.id = ol.order_id WHERE ol.refunded_at IS NULL`);
  assert.deepStrictEqual(['status', 'is_test', 'refunded_at'].map((f) => filterRow(viaCte, f).verdict), ['match', 'match', 'match']);
  const viaOn = check('revenue', "SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id AND o.status = 'paid' AND o.is_test IS FALSE WHERE ol.refunded_at IS NULL");
  assert.strictEqual(filterRow(viaOn, 'status').verdict, 'match', 'an INNER JOIN\u2019s ON filters rows');
  const leftOn = check('revenue', "SELECT SUM(ol.net_amount) FROM order_lines ol LEFT JOIN orders o ON o.id = ol.order_id AND o.status = 'paid' WHERE ol.refunded_at IS NULL AND NOT o.is_test");
  assert.strictEqual(filterRow(leftOn, 'status').verdict, 'different');
  assert.match(filterRow(leftOn, 'status').why, /LEFT JOIN/);
  const opp = check('revenue', GOOD_REV("o.status = 'paid' AND o.is_test = true AND ol.refunded_at IS NULL"));
  assert.strictEqual(filterRow(opp, 'is_test').verdict, 'different');
  assert.match(opp.verdict.line, /test orders only/);
  const wide = check('revenue', GOOD_REV("o.status IN ('paid', 'pending') AND o.is_test = false AND ol.refunded_at IS NULL"));
  assert.match(filterRow(wide, 'status').why, /also lets in 'pending'/);
  const or = check('revenue', GOOD_REV("o.status = 'paid' AND (o.is_test = false OR o.channel = 'cafe') AND ol.refunded_at IS NULL"));
  assert.strictEqual(filterRow(or, 'is_test').verdict, 'different');
  assert.match(filterRow(or, 'is_test').why, /inside an OR/);
  const sub = check('orders', "SELECT COUNT(DISTINCT ol.order_id) FROM order_lines ol WHERE ol.order_id IN (SELECT id FROM orders WHERE status = 'paid' AND is_test = false)");
  assert.strictEqual(filterRow(sub, 'status').verdict, 'unsure', 'only a subquery tests it: check by hand');
  const never = check('revenue', 'SELECT SUM(net_amount) FROM order_lines WHERE refunded_at IS NULL');
  assert.strictEqual(filterRow(never, 'status').verdict, 'missing');
  assert.match(filterRow(never, 'status').why, /never reads orders/);
  // read twice, filtered once
  const twice = check('orders', `SELECT COUNT(DISTINCT id) FROM (SELECT id FROM orders WHERE status = 'paid' AND is_test = false
    UNION ALL SELECT id FROM orders WHERE status = 'paid') u`);
  assert.strictEqual(filterRow(twice, 'is_test').verdict, 'different');
  assert.match(filterRow(twice, 'is_test').why, /not where it is read again/);
});

test('date column: the canon\u2019s matches; created_at is Different; a period asked with no date filter is Missing; no period, not checked', () => {
  const wrong = check('revenue in Q3 2026', GOOD_REV().replace(/paid_at/g, 'created_at'));
  assert.strictEqual(verdict(wrong, 'date'), 'different');
  assert.match(wrong.verdict.line, /created_at instead of paid_at/);
  const none = check('revenue last quarter', "SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL");
  assert.strictEqual(verdict(none, 'date'), 'missing');
  assert.match(row(none, 'date').why, /last quarter \(Q3 2026\)/);
  const notAsked = check('total revenue', "SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL");
  assert.strictEqual(verdict(notAsked, 'date'), 'absent');
  assert.ok(notAsked.metrics[0].notChecked.some((n) => /no period/.test(n)));
  const grouped = check('revenue by month', "SELECT DATE_TRUNC('month', o.created_at AT TIME ZONE 'America/New_York'), SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL GROUP BY 1");
  assert.strictEqual(verdict(grouped, 'date'), 'different', 'grouping by the wrong date column counts too');
});

test('time zone: converted (AT TIME ZONE, CONVERT_TZ, BigQuery DATETIME, an offset in the bound) matches; none is Missing; another zone is Different', () => {
  for (const conv of ["o.paid_at AT TIME ZONE 'America/New_York'", "CONVERT_TZ(o.paid_at, '+00:00', 'America/New_York')", "DATETIME(o.paid_at, 'America/New_York')", "o.paid_at AT TIME ZONE 'UTC' AT TIME ZONE 'US/Eastern'", "convert_timezone('America/New_York', o.paid_at)"]) {
    const sql = `SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL AND ${conv} >= '2026-07-01' AND ${conv} < '2026-10-01'`;
    assert.strictEqual(verdict(check('revenue in Q3 2026', sql), 'timezone'), 'match', conv);
  }
  const offset = check('revenue in Q3 2026', "SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL AND o.paid_at >= '2026-07-01 00:00:00-04' AND o.paid_at < '2026-10-01 00:00:00-04'");
  assert.strictEqual(verdict(offset, 'timezone'), 'match');
  const utc = check('revenue in Q3 2026', GOOD_REV().replace(/ AT TIME ZONE 'America\/New_York'/g, ''));
  assert.strictEqual(verdict(utc, 'timezone'), 'missing');
  assert.match(utc.verdict.line, /days in UTC, not America\/New_York/);
  const london = check('revenue in Q3 2026', GOOD_REV().replace(/America\/New_York/g, 'Europe/London'));
  assert.strictEqual(verdict(london, 'timezone'), 'different');
  const utcCanon = CANON();
  utcCanon.metrics[0].date.tz = 'UTC';
  assert.strictEqual(verdict(check('revenue in Q3 2026', GOOD_REV().replace(/ AT TIME ZONE 'America\/New_York'/g, ''), { canon: utcCanon }), 'timezone'), 'absent', 'a UTC canon asks for no conversion');
});

test('date range: half-open matches the question; BETWEEN and <= on a timestamp cut off the last day; 23:59:59 loses the last second; a date-typed column is fine', () => {
  const base = (range) => `SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL AND ${range}`;
  const tz = "o.paid_at AT TIME ZONE 'America/New_York'";
  const between = check('revenue in Q3 2026', base(`${tz} BETWEEN '2026-07-01' AND '2026-09-30'`));
  assert.strictEqual(verdict(between, 'range'), 'different');
  assert.match(row(between, 'range').why, /stops at 00:00 on Sep 30, 2026, so that whole day is left out/);
  assert.match(between.verdict.line, /the last day \(Sep 30, 2026\) is cut off/);
  const lte = check('revenue in Q3 2026', base(`${tz} >= '2026-07-01' AND ${tz} <= '2026-09-30'`));
  assert.strictEqual(verdict(lte, 'range'), 'different');
  const second = check('revenue in Q3 2026', base(`${tz} BETWEEN '2026-07-01 00:00:00' AND '2026-09-30 23:59:59'`));
  assert.match(row(second, 'range').why, /last second/);
  const onDay = check('revenue in Q3 2026', base(`CAST(${tz} AS DATE) BETWEEN '2026-07-01' AND '2026-09-30'`));
  assert.strictEqual(verdict(onDay, 'range'), 'match', 'BETWEEN on a date (cast) keeps the last day');
  const dateCol = Object.assign(CANON());
  dateCol.metrics[0].date = { column: 'orders.paid_date', tz: '' };
  dateCol.tables[1].columns.push('paid_date');
  assert.strictEqual(verdict(check('revenue in Q3 2026', base("o.paid_date BETWEEN '2026-07-01' AND '2026-09-30'"), { canon: dateCol }), 'range'), 'match', 'a column named *_date is a date');
  const off = check('revenue in Q3 2026', base(`${tz} >= '2026-07-01' AND ${tz} < '2026-09-30'`));
  assert.strictEqual(verdict(off, 'range'), 'different');
  assert.match(row(off, 'range').why, /Covers Jul 1 \u2013 Sep 29, 2026; Q3 2026 is Jul 1 \u2013 Sep 30, 2026/);
  const rel = check('revenue last quarter', base(`${tz} >= date_trunc('quarter', now()) - interval '3 months' AND ${tz} < date_trunc('quarter', now())`));
  assert.strictEqual(verdict(rel, 'range'), 'unsure');
  const param = check('revenue in Q3 2026', base(`${tz} >= :start AND ${tz} < :end`));
  assert.strictEqual(verdict(param, 'range'), 'unsure');
});

test('grain and fan-out: SUM of an order total after joining its lines, and COUNT(*) after a join, double count; many-to-one joins and COUNT(DISTINCT) do not', () => {
  const sumTotal = check('revenue by category', "SELECT p.category, SUM(o.total) FROM orders o JOIN order_lines ol ON ol.order_id = o.id JOIN products p ON p.id = ol.product_id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL GROUP BY 1");
  assert.strictEqual(verdict(sumTotal, 'grain'), 'different');
  assert.match(row(sumTotal, 'grain').why, /each orders row is added once per order_lines row/);
  const star = check('how many orders', "SELECT COUNT(*) FROM orders o JOIN order_lines ol ON ol.order_id = o.id WHERE o.status = 'paid' AND NOT o.is_test");
  assert.strictEqual(verdict(star, 'grain'), 'different');
  assert.match(star.verdict.line, /double counting from the join to order_lines/);
  const distinct = check('how many orders', "SELECT COUNT(DISTINCT o.id) FROM orders o JOIN order_lines ol ON ol.order_id = o.id WHERE o.status = 'paid' AND NOT o.is_test");
  assert.strictEqual(verdict(distinct, 'grain'), 'match');
  const manyToOne = check('revenue', GOOD_REV(null, { join: '\nJOIN products p ON p.id = ol.product_id\nJOIN customers c ON c.id = o.customer_id' }));
  assert.strictEqual(verdict(manyToOne, 'grain'), 'match', 'lines joined up to orders, products and customers multiply nothing');
  const lines = check('how many orders', "SELECT COUNT(*) FROM order_lines ol WHERE ol.refunded_at IS NULL");
  assert.strictEqual(verdict(lines, 'grain'), 'different');
  assert.match(row(lines, 'grain').why, /counts order_lines rows, not orders/);
  const unknown = check('revenue', GOOD_REV(null, { join: '\nJOIN shipments s ON s.order_id = o.id' }));
  assert.strictEqual(verdict(unknown, 'grain'), 'unsure');
  assert.match(row(unknown, 'grain').why, /schema notes don\u2019t say/);
  const preAgg = check('revenue', `WITH per_order AS (SELECT order_id, SUM(net_amount) AS amt FROM order_lines WHERE refunded_at IS NULL GROUP BY order_id)
    SELECT SUM(o.total) FROM orders o JOIN per_order p ON p.order_id = o.id WHERE o.status = 'paid' AND NOT o.is_test`);
  assert.notStrictEqual(verdict(preAgg, 'grain'), 'different', 'a pre-aggregated join keeps one row per order');
  const sumDistinct = check('revenue', GOOD_REV(null, { select: 'SUM(DISTINCT ol.net_amount)' }));
  assert.strictEqual(verdict(sumDistinct, 'grain'), 'unsure');
});

test('dimensions: an allowed split matches; any other is Different; "by channel" with no grouping is Missing; time grouping is always allowed', () => {
  const ok = check('revenue by channel', GOOD_REV(null, { select: 'o.channel, SUM(ol.net_amount)', tail: '\nGROUP BY o.channel' }));
  assert.strictEqual(verdict(ok, 'dimensions'), 'match');
  const bad = check('revenue by customer', GOOD_REV(null, { select: 'c.name, SUM(ol.net_amount)', join: '\nJOIN customers c ON c.id = o.customer_id', tail: '\nGROUP BY c.name' }));
  assert.strictEqual(verdict(bad, 'dimensions'), 'different');
  assert.match(bad.verdict.line, /grouped by customers\.name \(not allowed\)/);
  const pos = check('revenue by customer', GOOD_REV(null, { select: 'c.name AS who, SUM(ol.net_amount)', join: '\nJOIN customers c ON c.id = o.customer_id', tail: '\nGROUP BY 1' }));
  assert.strictEqual(verdict(pos, 'dimensions'), 'different', 'GROUP BY 1 is resolved to the select list');
  const asked = check('revenue by channel in Q3 2026', GOOD_REV());
  assert.strictEqual(verdict(asked, 'dimensions'), 'missing');
  assert.match(asked.verdict.line, /not grouped by channel/);
  const month = check('revenue by month', GOOD_REV(null, { select: "DATE_TRUNC('month', o.paid_at AT TIME ZONE 'America/New_York') AS m, SUM(ol.net_amount)", tail: '\nGROUP BY m' }));
  assert.strictEqual(verdict(month, 'dimensions'), 'match');
});

test('other filters: a condition the canon does not have is listed as Can\u2019t tell, never counted as a problem', () => {
  const r = check('revenue', GOOD_REV("o.status = 'paid' AND o.is_test = false AND ol.refunded_at IS NULL AND ol.quantity > 1"));
  assert.strictEqual(verdict(r, 'extra'), 'unsure');
  assert.match(row(r, 'extra').why, /ol\.quantity > 1/);
  assert.strictEqual(r.verdict.kind, 'unsure');
  assert.strictEqual(verdict(check('revenue by channel', GOOD_REV("o.status = 'paid' AND o.is_test = false AND ol.refunded_at IS NULL AND o.channel = 'web'")), 'extra'), 'absent', 'a filter on an allowed dimension is a slice, not a surprise');
});

/* ================================================================== *
 * Question matching and periods
 * ================================================================== */

test('question -> metric: by name and other names, plurals, longest phrase first, several at once; none falls back to the SQL; hand-picked wins', () => {
  const canon = CANON();
  const ids = (q) => C.matchQuestion(q, canon).map((m) => m.id);
  assert.deepStrictEqual(ids('What was revenue last quarter?'), ['revenue']);
  assert.deepStrictEqual(ids('Total SALES in September'), ['revenue']);
  assert.deepStrictEqual(ids("What's our GMV?"), ['revenue']);
  assert.deepStrictEqual(ids('How many orders did we get?'), ['orders']);
  assert.deepStrictEqual(ids('average order value by channel'), ['average-order-value']);
  assert.deepStrictEqual(ids('AOV and the refund rate for Q3'), ['average-order-value', 'refund-rate']);
  assert.deepStrictEqual(ids('Revenue and orders by region'), ['revenue', 'orders']);
  assert.deepStrictEqual(ids('unique customers per month'), ['active-customers']);
  assert.deepStrictEqual(ids('How is the weather?'), []);
  const viaSql = check('how are we doing?', GOOD_REV());
  assert.deepStrictEqual(viaSql.metrics.map((m) => [m.id, m.how]), [['revenue', 'sql']], 'matched by the measure\u2019s column');
  const nothing = check('how are we doing?', 'SELECT COUNT(*) FROM shipments');
  assert.strictEqual(nothing.verdict.kind, 'none');
  assert.ok(nothing.verdict.pick);
  const picked = check('how are we doing?', 'SELECT COUNT(*) FROM shipments', { metrics: ['orders', 'nope'] });
  assert.deepStrictEqual(picked.metrics.map((m) => [m.id, m.how]), [['orders', 'picked']]);
});

test('the period a question asks for, given today', () => {
  const t = (q, today = TODAY) => { const r = C.timeAsk(q, today); return r && r.exact !== false ? `${r.start}..${r.end}` : r ? 'rolling' : null; };
  assert.strictEqual(t('revenue in Q3 2026'), '2026-07-01..2026-10-01');
  assert.strictEqual(t('2026 Q4 revenue'), '2026-10-01..2027-01-01');
  assert.strictEqual(t('revenue last quarter'), '2026-07-01..2026-10-01');
  assert.strictEqual(t('revenue last quarter', '2026-02-10'), '2025-10-01..2026-01-01');
  assert.strictEqual(t('orders last month'), '2026-09-01..2026-10-01');
  assert.strictEqual(t('orders last month', '2026-01-15'), '2025-12-01..2026-01-01');
  assert.strictEqual(t('sales in September'), '2026-09-01..2026-10-01');
  assert.strictEqual(t('sales in December'), '2025-12-01..2026-01-01', 'a month still to come is last year\u2019s');
  assert.strictEqual(t('sales in feb 2024'), '2024-02-01..2024-03-01');
  assert.strictEqual(t('revenue this year'), '2026-01-01..2026-10-28');
  assert.strictEqual(t('revenue yesterday'), '2026-10-26..2026-10-27');
  assert.strictEqual(t('revenue last week'), '2026-10-19..2026-10-26', 'weeks run Monday to Sunday');
  assert.strictEqual(t('revenue for the last 30 days'), 'rolling');
  assert.strictEqual(t('may I see revenue?'), null, '"may" is a verb unless it reads as a month');
  assert.strictEqual(t('revenue in May'), '2026-05-01..2026-06-01');
  assert.strictEqual(t('revenue in 2025'), '2025-01-01..2026-01-01');
  assert.strictEqual(C.grainAsk('revenue by month'), 'month');
  assert.strictEqual(C.grainAsk('weekly active customers'), 'week');
  assert.deepStrictEqual(C.dimAsk('revenue by channel in Q3'), ['channel']);
  assert.deepStrictEqual(C.dimAsk('orders split by product category, last month'), ['product category']);
});

/* ================================================================== *
 * The fix
 * ================================================================== */

test('the fix: missing filters added with the SQL\u2019s own alias and keyword case, as pure additions; applying it checks clean', () => {
  const [refunds] = D.answers();
  const r = check(refunds.question, refunds.sql);
  assert.deepStrictEqual(r.fix.changes.map((c) => [c.what, c.text]), [['Keeps out refunds', 'ol.refunded_at IS NULL'], ['Keeps out test orders', 'o.is_test = false']]);
  assert.ok(r.fix.diff.filter((d) => d.k !== ' ').every((d) => d.k === '+'), 'only added lines - the existing ones are left alone');
  assert.ok(r.fix.sql.includes("WHERE o.status = 'paid'\n  AND ol.refunded_at IS NULL\n  AND o.is_test = false\n  AND o.paid_at"), r.fix.sql);
  assert.strictEqual(check(refunds.question, r.fix.sql).verdict.kind, 'ok', 'the fixed SQL matches the canon');
  // no WHERE at all; lowercase keywords; a WHERE with a top-level OR is wrapped first
  const lower = check('revenue', 'select sum(ol.net_amount) from order_lines ol join orders o on o.id = ol.order_id');
  assert.match(lower.fix.sql, /\nwhere o\.status = 'paid'\n {2}and ol\.refunded_at is null|\nwhere o\.status = 'paid'\n {2}and ol\.refunded_at IS NULL/);
  assert.ok(lower.fix.sql.startsWith('select sum(ol.net_amount) from order_lines ol join orders o on o.id = ol.order_id\nwhere '));
  const ored = check('revenue', "SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND o.is_test = false OR o.channel = 'cafe'");
  assert.match(ored.fix.sql, /WHERE \(o\.status = 'paid' AND o\.is_test = false OR o\.channel = 'cafe'\)\n {2}AND ol\.refunded_at IS NULL/);
  // a filter whose table is never read is not added - it needs a join
  const never = check('revenue', 'SELECT SUM(net_amount) FROM order_lines WHERE refunded_at IS NULL');
  assert.strictEqual(never.fix.sql, null);
  assert.ok(never.fix.skipped.some((s) => /join orders first/.test(s)));
  // never applied: the fix is a suggestion object, the input SQL is untouched
  assert.strictEqual(r.sql, refunds.sql);
});

test('the fix: COUNT(DISTINCT) for a fan-out count, a half-open range for the BETWEEN trap, the canon\u2019s date column - and nothing for what is not safe', () => {
  const [, fanout] = D.answers();
  const f = check(fanout.question, fanout.sql);
  assert.match(f.fix.sql, /SUM\(ol\.net_amount\) \/ COUNT\(DISTINCT o\.id\) AS avg_order_value/);
  assert.strictEqual(check(fanout.question, f.fix.sql).verdict.kind, 'ok');
  const star = check('how many orders', "SELECT COUNT(*) FROM orders o JOIN order_lines ol ON ol.order_id = o.id WHERE o.status = 'paid' AND NOT o.is_test");
  assert.match(star.fix.sql, /COUNT\(DISTINCT o\.id\)/);
  const tz = "o.paid_at AT TIME ZONE 'America/New_York'";
  const b = check('revenue in Q3 2026', `SELECT SUM(ol.net_amount) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL AND ${tz} BETWEEN DATE '2026-07-01' AND DATE '2026-09-30'`);
  assert.ok(b.fix.sql.includes(`${tz} >= DATE '2026-07-01' AND ${tz} < DATE '2026-10-01'`), b.fix.sql);
  assert.strictEqual(check('revenue in Q3 2026', b.fix.sql).verdict.kind, 'ok');
  const lte = check('revenue in Q3 2026', GOOD_REV().replace("< '2026-10-01'", "<= '2026-09-30'"));
  assert.ok(lte.fix.sql.includes("< '2026-10-01'"));
  const swap = check('revenue in Q3 2026', GOOD_REV().replace(/o\.paid_at/g, 'o.created_at'));
  assert.ok(!/created_at/.test(swap.fix.sql) && /o\.paid_at AT TIME ZONE/.test(swap.fix.sql), swap.fix.sql);
  const src = check('revenue in Q3 2026', GOOD_REV(null, { select: 'SUM(o.total)' }));
  assert.ok(src.fix.skipped.some((s) => /different columns/.test(s)), 'a different source column is never swapped automatically');
  const utc = check('revenue in Q3 2026', GOOD_REV().replace(/ AT TIME ZONE 'America\/New_York'/g, ''));
  assert.ok(utc.fix.skipped.some((s) => /depends on your database/.test(s)), 'time zone conversion is dialect-specific: not automatic');
  const sumTotal = check('revenue', "SELECT SUM(o.total) FROM orders o JOIN order_lines ol ON ol.order_id = o.id WHERE o.status = 'paid' AND NOT o.is_test AND ol.refunded_at IS NULL");
  assert.ok(sumTotal.fix.skipped.some((s) => /join has to change/.test(s)));
  assert.deepStrictEqual(C.lineDiff('a\nb\nc', 'a\nb2\nc'), [{ k: ' ', t: 'a' }, { k: '-', t: 'b' }, { k: '+', t: 'b2' }, { k: ' ', t: 'c' }]);
});

test('hostile SQL: no throw on garbage, unbalanced parens, huge input, invisible characters (removed and said)', () => {
  for (const sql of [')))(((', 'SELECT', "SELECT 'unterminated", 'SELECT ( FROM WHERE', 'WITH x AS (', '{{ junk', 'DROP TABLE orders; --', 'x'.repeat(5000), 'SELECT ' + '('.repeat(500) + '1' + ')'.repeat(500), 'SELECT SUM(a) FROM t WHERE ' + Array.from({ length: 400 }, (_, i) => `c${i} = ${i}`).join(' AND ')]) {
    const r = check('revenue', sql);
    assert.ok(r.verdict && typeof r.verdict.line === 'string', sql.slice(0, 40));
  }
  assert.match(check('revenue', 'x'.repeat(C.LIMITS.sqlChars + 1)).verdict.line, /over 60,000 characters/);
  const bidi = check('revenue', GOOD_REV().replace("'paid'", "'pa\u202eid\u200b'"));
  assert.ok(bidi.notes.some((n) => /2 invisible characters/.test(n)));
  assert.ok(!/[\u202e\u200b]/.test(bidi.sql));
});

/* ================================================================== *
 * The canon: cleaning, merge, exports, import
 * ================================================================== */

test('cleaning: names and measures required, every field bounded, invisible characters gone, ids slugged and unique', () => {
  const c = C.cleanCanon({ name: 'A\u202e Co', metrics: [
    { name: 'Revenue', measure: 'SUM(x.y)', synonyms: ['sales', 'Revenue', 'SALES', ...Array(30).fill('z')], filters: ['x.a = 1', { sql: 'x.b IS NULL; DROP TABLE x', keepsOut: 'b' }, { sql: 'x.c = 1', keepsOut: 'k'.repeat(200) }], date: { column: 'x.d', tz: '../../etc' } },
    { name: 'Revenue', measure: 'COUNT(*)' },
    { name: '', measure: 'SUM(1)' },
    { name: 'No measure' },
    { name: 'Long', measure: 'SUM(' + 'a'.repeat(500) + ')' },
  ], tables: [{ name: 'x', columns: ['a', 'b', 'a'] }, { name: 'X' }, { name: '' }], relationships: [{ one: 'x.id', many: 'y.x_id' }, { one: 'x.id', many: 'x.parent' }, { one: 'nodot', many: 'y.z' }] });
  assert.strictEqual(c.name, 'A Co');
  assert.deepStrictEqual(c.metrics.map((m) => m.id), ['revenue', 'revenue-2']);
  assert.deepStrictEqual(c.metrics[0].synonyms.slice(0, 2), ['sales', 'z'], 'the name itself and duplicates are dropped');
  assert.strictEqual(c.metrics[0].synonyms.length, 2);
  assert.deepStrictEqual(c.metrics[0].filters.map((f) => f.sql), ['x.a = 1', 'x.c = 1'], 'a filter with a statement break is refused');
  assert.strictEqual(c.metrics[0].filters[1].keepsOut.length, C.LIMITS.keepsOutChars);
  assert.strictEqual(c.metrics[0].date.tz, '', 'a time zone must look like one');
  assert.deepStrictEqual(c.tables.map((t) => [t.name, t.columns]), [['x', ['a', 'b']]]);
  assert.deepStrictEqual(c.relationships, [{ one: 'x.id', many: 'y.x_id' }]);
  assert.strictEqual(C.cleanCanon('nope'), null);
});

test('merge: by id or name, the newer copy of each wins, nothing lost from either side', () => {
  const a = { name: 'A', updatedAt: 10, metrics: [{ id: 'revenue', name: 'Revenue', measure: 'SUM(x.a)', updatedAt: 5 }, { id: 'orders', name: 'Orders', measure: 'COUNT(*)', updatedAt: 5 }], tables: [{ name: 't1' }] };
  const b = { name: 'B', updatedAt: 20, metrics: [{ id: 'revenue', name: 'Revenue', measure: 'SUM(x.b)', updatedAt: 9 }, { id: 'aov', name: 'AOV', measure: 'AVG(x.c)', updatedAt: 1 }, { id: 'ord2', name: 'orders', measure: 'COUNT(DISTINCT x.id)', updatedAt: 1 }], tables: [{ name: 't2' }] };
  const m = C.mergeCanons(a, b);
  assert.strictEqual(m.name, 'B');
  assert.deepStrictEqual(m.metrics.map((x) => `${x.id}:${x.measure}`), ['revenue:SUM(x.b)', 'orders:COUNT(*)', 'aov:AVG(x.c)']);
  assert.deepStrictEqual(m.tables.map((t) => t.name), ['t1', 't2']);
});

test('export: Markdown for an AI tool, YAML labelled dbt-style (and safely quoted), JSON that imports back exactly', () => {
  const canon = CANON();
  const md = C.toMarkdown(canon, TODAY);
  assert.match(md, /^# Fernhill Coffee Co\. - metric definitions/);
  assert.match(md, /compute it exactly as written here/);
  assert.match(md, /## Revenue\nAlso called: sales, net sales, GMV, takings, turnover\./);
  assert.match(md, /- \*\*Measure:\*\* `SUM\(order_lines\.net_amount\)`/);
  assert.match(md, /  - `order_lines\.refunded_at IS NULL` - keeps out refunds/);
  assert.match(md, /- \*\*Date:\*\* `orders\.paid_at`, with days in `America\/New_York`/);
  assert.match(md, /\| orders \| order \| id \|/);
  assert.match(md, /One `orders` row has many `order_lines` rows/);
  const yaml = C.toYaml(canon, TODAY);
  assert.match(yaml, /^# dbt-style: shaped like a dbt semantic layer file/);
  assert.match(yaml, /NOT checked against dbt and is not guaranteed to be valid/);
  assert.match(yaml, /  - name: revenue\n    label: "Revenue"/);
  assert.match(yaml, /    type: ratio\n    type_params:\n      expr: "SUM\(order_lines\.net_amount\) \/ COUNT\(DISTINCT orders\.id\)"/);
  assert.match(yaml, /    filter: \|\n      orders\.status = 'paid'\n      AND order_lines\.refunded_at IS NULL\n      AND orders\.is_test = false/);
  assert.match(yaml, /      timezone: "America\/New_York"/);
  // hostile strings stay inside their quotes
  const evil = C.cleanCanon({ name: 'Evil\nname: x', metrics: [{ name: 'A "quoted": name\n- injected: true', measure: 'SUM(t.a)', meaning: 'line\nbreak # not a comment', owner: '\\ back' }] });
  const ey = C.toYaml(evil, TODAY);
  assert.ok(ey.includes('label: "A \\"quoted\\": name - injected: true"'));
  assert.ok(ey.includes('description: "line\\nbreak # not a comment"'));
  assert.ok(!/^- injected/m.test(ey) && !/^name: x/m.test(ey), 'nothing breaks out onto its own line');
  const em = C.toMarkdown(C.cleanCanon({ name: 'X', metrics: [{ name: '<script>a</script> | pipe', measure: 'SUM(`t`.a)' }], tables: [{ name: 'a|b', grain: 'x|y' }] }));
  assert.ok(em.includes('## \\<script\\>a\\</script\\> \\| pipe'));
  assert.ok(em.includes('`` SUM(`t`.a) ``'), 'a backtick in code gets a longer fence');
  assert.ok(em.includes('| a\\|b | x\\|y |'));
  const json = C.exportJson(canon, TODAY);
  const back = C.importJson(json);
  assert.deepStrictEqual(back.canon.metrics, canon.metrics);
  assert.deepStrictEqual([back.canon.tables, back.canon.relationships], [canon.tables, canon.relationships]);
  assert.strictEqual(back.canon.sample, false, 'an imported canon is never the example');
  assert.strictEqual(JSON.parse(json).canon.sample, undefined);
});

test('import: refuses what is not a canon, says what it left out, and cleans every field', () => {
  const bad = (text, re) => assert.throws(() => C.importJson(text), re);
  bad('', /empty/);
  bad('not json', /isn\u2019t JSON/);
  bad('[]', /isn\u2019t a canon/);
  bad(JSON.stringify({ app: 'rep', workouts: [] }), /from rep, not Canon/);
  bad(JSON.stringify({ canon: { name: 'x' } }), /No metrics/);
  bad(JSON.stringify({ metrics: [{ name: 'no measure' }] }), /None of the metrics/);
  bad('{"metrics":[' + '"x",'.repeat(300000) + '"x"]}', /over 1 MB/);
  const r = C.importJson(JSON.stringify({ app: 'canon', canon: { name: '<b>Co</b>', metrics: [{ name: 'Good', measure: 'SUM(t.a)', __proto__x: 1 }, { name: 'Bad' }, 7] } }));
  assert.deepStrictEqual(r.counts, { metrics: 1, tables: 0, relationships: 0 });
  assert.deepStrictEqual(r.skipped.map((s) => s.what), ['Bad', 'metric 3']);
  assert.strictEqual(r.canon.name, '<b>Co</b>', 'kept as text - it is escaped wherever it is drawn');
  assert.deepStrictEqual(Object.keys(r.canon.metrics[0]).sort(), ['date', 'dimensions', 'filters', 'grain', 'id', 'meaning', 'measure', 'name', 'owner', 'synonyms', 'tables', 'traps', 'updatedAt']);
});

test('schema text: CREATE TABLE (keys, REFERENCES, FOREIGN KEY, ALTER TABLE), describe output, information_schema rows and plain lists', () => {
  const ddl = C.parseSchemaText(`CREATE TABLE IF NOT EXISTS shop.customers (id bigint PRIMARY KEY, name text, region varchar(40));
CREATE TABLE "orders" (
  "id" bigint NOT NULL, customer_id bigint REFERENCES customers(id), status text, total numeric(12,2), paid_at timestamptz,
  PRIMARY KEY (id)
);
CREATE TABLE order_lines (id bigint primary key, order_id bigint, product_id bigint, net_amount numeric(12,2), CONSTRAINT fk FOREIGN KEY (order_id) REFERENCES orders (id));
CREATE TABLE products (id bigint primary key, category text);
ALTER TABLE order_lines ADD CONSTRAINT fk2 FOREIGN KEY (product_id) REFERENCES products (id);`);
  assert.deepStrictEqual(ddl.tables.map((t) => `${t.name}:${t.key}:${t.columns.length}`), ['shop.customers:id:3', 'orders:id:5', 'order_lines:id:4', 'products:id:2']);
  assert.strictEqual(ddl.tables[1].columns.find((c) => c.name === 'total').type, 'numeric(12,2)');
  assert.deepStrictEqual(ddl.relationships.map((r) => `${r.one}>${r.many}`), ['shop.customers.id>orders.customer_id', 'orders.id>order_lines.order_id', 'products.id>order_lines.product_id']);
  const desc = C.parseSchemaText(`DESCRIBE orders;
+-------------+--------------+------+-----+
| Field       | Type         | Null | Key |
+-------------+--------------+------+-----+
| id          | int          | NO   | PRI |
| customer_id | int          | YES  |     |
| status      | varchar(20)  | YES  |     |
+-------------+--------------+------+-----+`);
  assert.deepStrictEqual(desc.tables.map((t) => [t.name, t.key, t.columns.map((c) => c.name)]), [['orders', 'id', ['id', 'customer_id', 'status']]]);
  const info = C.parseSchemaText('table_name,column_name,data_type\norders,id,bigint\norders,customer_id,bigint\ncustomers,id,bigint');
  assert.deepStrictEqual(info.tables.map((t) => t.name), ['orders', 'customers']);
  assert.deepStrictEqual(info.relationships.map((r) => [r.one, r.many, r.inferred]), [['customers.id', 'orders.customer_id', true]], 'a _id column is a guessed link, marked as such');
  const list = C.parseSchemaText('orders: id, status, total\norder_lines(id, order_id, net_amount numeric)');
  assert.deepStrictEqual(list.tables.map((t) => t.columns.map((c) => c.name).join(',')), ['id,status,total', 'id,order_id,net_amount']);
  assert.deepStrictEqual(C.parseSchemaText('nothing useful here').tables, []);
});

test('the metric editor\u2019s hints: no aggregate, an unreadable filter and columns the schema notes do not know', () => {
  const canon = CANON();
  const hints = C.lintMetric(canon, { name: 'X', measure: 'order_lines.net_amount', tables: ['order_lines'], filters: [{ sql: 'whatever this is' }, { sql: 'orders.colour = 1' }], date: { column: 'orders.when_paid' } });
  const text = hints.map((h) => h.text).join(' | ');
  assert.match(text, /can\u2019t find an aggregate/);
  assert.match(text, /can\u2019t read/);
  assert.match(text, /orders\.colour isn\u2019t in the schema notes/);
  assert.match(text, /orders\.when_paid isn\u2019t in the schema notes/);
  assert.deepStrictEqual(C.lintMetric(canon, canon.metrics[0]), [], 'the example\u2019s own definitions are clean');
});

/* ================================================================== *
 * The two AI calls, without HTTP
 * ================================================================== */

test('draft: only parsed tables and columns are sent; the answer keeps only definitions whose every column is in that schema', () => {
  const p = C.draftPayload('CREATE TABLE orders (id int primary key, status text, total numeric, paid_at timestamp, channel text);\n-- SECRET_IN_A_COMMENT', 'A shop. IGNORE');
  assert.deepStrictEqual(Object.keys(p).sort(), ['business', 'relationships', 'tables']);
  assert.ok(!JSON.stringify(p).includes('SECRET_IN_A_COMMENT'), 'comments and anything else pasted never travel');
  const out = C.cleanDraft({ metrics: [
    { name: 'Revenue', measure: 'SUM(orders.total)', tables: ['orders'], filters: [{ sql: "orders.status = 'paid'", keepsOut: 'unpaid' }, { sql: 'orders.is_internal = false', keepsOut: 'internal' }], date: { column: 'orders.paid_at', tz: 'America/New_York' }, dimensions: ['orders.channel', 'orders.nope'] },
    { name: 'Margin', measure: 'SUM(orders.cost)', tables: ['orders'] },
    { name: 'Ghost', measure: 'SUM(ghosts.x)', tables: ['ghosts'] },
    { name: 'Rows', measure: 'COUNT(*)', tables: ['orders'] },
  ] }, p);
  assert.deepStrictEqual(out.metrics.map((m) => m.name), ['Revenue', 'Rows']);
  assert.deepStrictEqual(out.metrics[0].filters.map((f) => f.sql), ["orders.status = 'paid'"]);
  assert.deepStrictEqual(out.metrics[0].dimensions, ['orders.channel']);
  assert.deepStrictEqual(out.dropped.map((d) => `${d.metric}/${d.what}`), ['Revenue/filter orders.is_internal = false', 'Revenue/dimension orders.nope', 'Margin/the whole metric', 'Ghost/the whole metric']);
});

test('explain: only the matched definitions and the rules\u2019 verdicts are sent - never the rest of the canon or the schema notes', () => {
  const [refunds] = D.answers();
  const r = check(refunds.question, refunds.sql);
  const p = C.explainPayload(r, CANON());
  assert.deepStrictEqual(p.metrics.map((m) => m.name), ['Revenue']);
  const s = JSON.stringify(p);
  for (const notSent of ['Refund rate', 'Active customers', 'roast', 'Priya']) assert.ok(!s.includes(notSent), `${notSent} was in the payload`);
  assert.ok(p.checks.some((c) => c.verdict === 'missing' && /refunded_at/.test(c.check)));
  assert.strictEqual(C.explainRequest({ sql: 'x', metrics: [] }), null);
  assert.strictEqual(C.explainRequest({ sql: 'x'.repeat(C.LIMITS.explainSqlChars + 1), metrics: [{ name: 'a', measure: 'SUM(1)' }] }), null);
  const clean = C.cleanExplanation({ computes: '<script>x</script>Adds <b>up</b>', verdict: 'nope', differences: [{ what: '<img src=x>Refunds', canon: 'a' }, { what: '' }] }, p);
  assert.deepStrictEqual([clean.computes, clean.verdict, clean.differences.length, clean.differences[0].what], ['xAdds up', 'unclear', 1, 'Refunds']);
  assert.strictEqual(C.cleanExplanation({ computes: '', differences: [] }, p), null);
});

/* ================================================================== *
 * The page's own promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes, the hero and the lab card too', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'code-bg', 'bar-bg']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('accent-ink', 'accent'); ok('text', 'accent-soft'); ok('link', 'accent-soft'); ok('muted', 'accent-soft');
    for (const k of ['ok', 'miss', 'diff', 'unsure']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); ok(k, 'card'); }
    for (const bg of ['add-bg', 'del-bg']) { ok('text', bg); ok('muted', bg); }
    ok('strip-ink', 'strip'); ok('bg', 'text');
    for (const tone of ['tone-ok', 'tone-miss', 'tone-diff', 'tone-unsure']) ok(tone, 'card', 2.3);
  }
  for (const bg of ['#15123a', '#23206b', '#0f4f5a']) for (const fg of ['#ffffff', '#dcdcf5', '#9fe7ee', '#eeeefb']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  for (const [fg, bg] of [['#221600', '#ffd166'], ['#16162b', '#fbfbff'], ['#4b4b66', '#fbfbff'], ['#166534', '#fbfbff'], ['#b42318', '#fbfbff'], ['#16162b', '#ececf7']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}`);
  const lab = require('../../../lab').get('canon');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  assert.ok(/\.btn \{[^}]*min-height: 44px/.test(css) && /\.link-btn \{[^}]*min-height: 44px/.test(css) && /\.tries button \{[^}]*min-height: 44px/.test(css) && /\.mchip \{[^}]*min-height: 44px/.test(css) && /\.seg button \{[^}]*min-height: 44px/.test(css) && /\.copen \{[^}]*min-height: 52px/.test(css), '44px tap targets');
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/textarea\.sql \{[^}]*overflow: auto/.test(css) && /\.pane pre \{[^}]*overflow-x: auto/.test(css) && /\.diff \{[^}]*overflow: auto/.test(css) && /\.out \{[^}]*overflow: auto/.test(css), 'SQL, diffs and exports scroll in their own box');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, no email, no clock or network in the core, every typed string escaped', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js) && /localStorage\.removeItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|indexedDB/.test(js));
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/canon', 'api/draft', 'api/explain', 'api/me', 'api/s/', 'api/shares', 'api/shares/'].sort(), 'the page asks for nothing else - no route takes SQL to check');
  const files = ['public/index.html', 'public/app.js', 'public/canon-core.js', 'public/demo.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'CLAUDE.md', 'test/run.js'];
  for (const f of files) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  for (const f of ['public/canon-core.js', 'public/demo.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(src), `${f} has no dice and no clock`);
    assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(src), `${f} carries no invisible characters of its own`);
  }
  // Every interpolation of something a person, a file, the server or a model wrote goes through esc().
  // (Plain-text builders - out.push for the "what will be sent" boxes, toasts, confirms - are escaped whole, or never markup.)
  assert.ok(/<pre class="sent-pre" tabindex="0">' \+ esc\(shown\)/.test(js), 'the plain-text payload is escaped as a whole');
  const risky = js.split('\n').filter((l) => !/toast\(|confirm\(|prompt\(|copy\(|download\(|textContent|out\.push\(/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(m\.name|c\.name|d\.name|t\.name|m\.measure|m\.meaning|m\.traps|m\.owner|f\.sql|f\.keepsOut|ck\.why|ck\.title|r\.one|r\.many|x\.text|s\.what|d\.what|e\.message|me\.email|state\.q|state\.sql|v\.line|n|p\.canon\.name|l\.createdAt|state\.lastLink|ch\.what|ch\.text|d\.t|x\.computes|x\.fix)\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bsent|\bsql|\bschema|\bcanon)\b/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /rel\.indexOf\('s\/'\) === 0\) return;/.test(sw) && /canon-shell-v1/.test(sw) && sw.includes("'canon-core.js'"), 'the service worker never answers api/ or a share link, and owns canon-* caches only');
  assert.match(read('public/demo.js'), /MADE-UP shop/);
  assert.match(js, /Made-up example/);
});

test('local-only switches throw on Cloud Run; the lab prefix is read; the only query is one equality filter', () => {
  for (const [mod, env] of [['./lib/store', { CANON_MEMORY: '1' }], ['./lib/fakeai', { CANON_FAKE_AI: '1' }], ['./server', { CANON_FAKE_AI: '1', CANON_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, CANON_MEMORY: '', CANON_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, CANON_MEMORY: '', CANON_COLLECTION_PREFIX: 'canon_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'canon_ firestore');
  const src = read('lib/store.js');
  assert.ok((src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.deepStrictEqual([...new Set(server.match(/store\.list\([^)]*\)/g))], ["store.list('shares', { where: [['owner', '==', tag]], limit: LIMITS.sharesOpen * 10 })"]);
  assert.ok(!/orderBy/.test(server));
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
// Test accounts on the reserved example domain, built here so no address is written into a file.
const mail = (who) => `${who}${String.fromCharCode(64)}example.com`;
const uidOf = (email) => Buffer.from(email).toString('base64url');
async function register(who) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const MINE = () => Object.assign(CANON(), { sample: false, name: 'Test Co' });
const BIG = { x: 'x'.repeat(900 * 1024) };
const draftBody = () => C.draftPayload('CREATE TABLE orders (id int primary key, customer_id int, status text, total numeric, paid_at timestamptz, channel text);\nCREATE TABLE customers (id int primary key, region text);', 'A small coffee shop.');
const explainBody = () => { const [a] = D.answers(); return C.explainPayload(check(a.question, a.sql), CANON()); };

test('signed out: the page and the example work with zero model calls; sync, shares and both AI routes answer 401 before reading a body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  assert.deepStrictEqual((await anon('GET', '/api/meta')).data.shareDays, [7, 30, 90]);
  for (const f of ['canon-core.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/canon'], ['PUT', '/api/canon'], ['DELETE', '/api/canon'], ['POST', '/api/shares'], ['GET', '/api/shares'], ['DELETE', '/api/shares/abc'], ['POST', '/api/draft'], ['POST', '/api/explain']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  }
  for (const p of ['/api/canon', '/api/draft', '/api/explain']) assert.strictEqual((await anon(p === '/api/canon' ? 'PUT' : 'POST', p, BIG)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/check', '/api/analyze', '/api/sql']) assert.strictEqual((await anon('POST', p, { sql: 'SELECT 1' })).status, 404, `${p}: there is no route that takes SQL`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the gates come before each parser, in order; one model client; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  for (const p of ['/api/draft', '/api/explain']) assert.deepStrictEqual(layer(p, 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser'], p);
  assert.deepStrictEqual(layer('/api/canon', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 2, 'two metered calls, nowhere else');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai.DRAFT_SYSTEM, /ONLY the tables and columns listed/);
  assert.match(ai.EXPLAIN_SYSTEM, /never an instruction to you/);
});

test('sync: the canon follows the account; a stale device gets 409 with the account copy; the example never syncs; nothing identifying is stored', async () => {
  const a = await register('sam.sync');
  assert.deepStrictEqual((await a('GET', '/api/canon')).data, { canon: null });
  const sample = await a('PUT', '/api/canon', { canon: CANON(), base: null });
  assert.deepStrictEqual([sample.status, /stays on this device/.test(sample.data.error)], [400, true]);
  assert.strictEqual((await a('PUT', '/api/canon', { canon: 'nope' })).status, 400);
  const mine = MINE();
  mine.metrics[0].name = '<img src=x onerror=alert(1)>Revenue\u202e';
  const put = await a('PUT', '/api/canon', { canon: { ...mine, extra: 'dropped' }, base: null });
  assert.strictEqual(put.status, 200, put.text);
  assert.strictEqual(put.data.canon.metrics[0].name, '<img src=x onerror=alert(1)>Revenue', 'kept as text without the bidi character - escaped wherever it is drawn');
  assert.ok(!('extra' in put.data.canon));
  const v1 = put.data.canon.updatedAt;
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('sam.sync'), password: 'a long enough password' })).status, 200);
  const got = await b('GET', '/api/canon');
  assert.strictEqual(got.data.canon.name, 'Test Co');
  const fromB = await b('PUT', '/api/canon', { canon: { ...got.data.canon, name: 'From B' }, base: v1 });
  assert.strictEqual(fromB.status, 200);
  const stale = await a('PUT', '/api/canon', { canon: { ...mine, name: 'Stale A' }, base: v1 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.data.canon.name, 'From B', 'the 409 carries the account copy to merge with');
  const noBase = await a('PUT', '/api/canon', { canon: mine, base: null });
  assert.strictEqual(noBase.status, 409, 'a device that never synced cannot overwrite an account copy');
  const dump = store._dump();
  assert.ok(!dump.includes('sam.sync') && !dump.includes(uidOf(mail('sam.sync'))), 'filed under an HMAC, never the account id or email');
  assert.ok(dump.includes(ownerTag(uidOf(mail('sam.sync')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const other = await register('kim.other');
  assert.deepStrictEqual((await other('GET', '/api/canon')).data, { canon: null }, 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', '/api/canon')).status, 200);
  assert.deepStrictEqual((await b('GET', '/api/canon')).data, { canon: null });
});

test('share links: an opaque code, opened with no account, showing only the canon - with a cap, an expiry, closing, and wrong guesses counted', async () => {
  const owner = await register('ana.share');
  assert.strictEqual((await owner('POST', '/api/shares', { days: 30 })).status, 409, 'nothing synced yet: nothing to share');
  const mine = MINE();
  assert.strictEqual((await owner('PUT', '/api/canon', { canon: mine, base: null })).status, 200);
  assert.strictEqual((await owner('POST', '/api/shares', { days: 5 })).status, 400, 'only 7, 30 or 90 days');
  const made = await owner('POST', '/api/shares', { days: 7 });
  assert.strictEqual(made.status, 200, made.text);
  assert.match(made.data.code, /^[A-Za-z0-9_-]{22}$/);
  assert.deepStrictEqual(Object.keys(made.data.link).sort(), ['createdAt', 'expiresAt', 'id', 'opens']);
  const days = (Date.parse(made.data.link.expiresAt) - Date.parse(made.data.link.createdAt)) / 86400000;
  assert.strictEqual(days, 7);
  assert.ok(!store._dump().includes(made.data.code), 'the code itself is never stored');
  const stranger = client();
  const open = await stranger('GET', `/api/s/${made.data.code}`);
  assert.strictEqual(open.status, 200, open.text);
  assert.deepStrictEqual(Object.keys(open.data).sort(), ['canon', 'expiresAt']);
  assert.deepStrictEqual(Object.keys(open.data.canon).sort(), ['metrics', 'name', 'relationships', 'tables', 'updatedAt'], 'only the canon');
  assert.strictEqual(open.data.canon.metrics.length, 5);
  assert.ok(!/sam|ana\.share|example\.com|owner/.test(JSON.stringify(open.data).replace(/"owner":"[^"]*"/g, (m) => m.replace('owner', 'own'))), 'no account, email or owner tag');
  assert.ok(!JSON.stringify(open.data).includes(ownerTag(uidOf(mail('ana.share')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  assert.strictEqual(open.headers.get('cache-control'), 'no-store');
  assert.strictEqual(open.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(open.headers.get('x-robots-tag'), 'noindex');
  assert.strictEqual((await stranger('POST', `/api/s/${made.data.code}`, {})).status, 405, 'read-only');
  // the page for a link resolves its assets against the app root
  const pg = await fetch(`${base}/s/${made.data.code}`);
  assert.strictEqual(pg.headers.get('referrer-policy'), 'no-referrer');
  assert.ok((await pg.text()).includes('<head>\n  <base href="../">'));
  // live: an edit that syncs shows up through the same link
  const v = (await owner('GET', '/api/canon')).data.canon;
  assert.strictEqual((await owner('PUT', '/api/canon', { canon: { ...v, name: 'Renamed Co' }, base: v.updatedAt })).status, 200);
  assert.strictEqual((await stranger('GET', `/api/s/${made.data.code}`)).data.canon.name, 'Renamed Co');
  const list = await owner('GET', '/api/shares');
  assert.strictEqual(list.data.links[0].opens, 2);
  // someone else cannot close it; the owner can, and then it is the same 404 as a link that never existed
  const other = await register('ola.other');
  assert.strictEqual((await other('DELETE', `/api/shares/${made.data.link.id}`)).status, 404);
  assert.strictEqual((await owner('DELETE', `/api/shares/${made.data.link.id}`)).status, 200);
  const gone = await stranger('GET', `/api/s/${made.data.code}`);
  assert.deepStrictEqual([gone.status, /isn\u2019t open any more/.test(gone.data.error)], [404, true]);
  // expiry: a link past its date answers 404 and is removed by the read that finds it
  const exp = await owner('POST', '/api/shares', { days: 90 });
  const id = shareId(exp.data.code);
  const doc = await store.get('shares', id);
  await store.set('shares', id, { ...doc, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.strictEqual((await stranger('GET', `/api/s/${exp.data.code}`)).status, 404);
  assert.strictEqual(await store.get('shares', id), null, 'the expired link is deleted');
  // the cap: ten open at once
  for (let i = 0; i < 10; i++) assert.strictEqual((await owner('POST', '/api/shares', { days: 30 })).status, 200, `link ${i + 1}`);
  const over = await owner('POST', '/api/shares', { days: 30 });
  assert.deepStrictEqual([over.status, /10 open links/.test(over.data.error)], [429, true]);
  // removing the canon from the account closes every link
  const any = (await owner('GET', '/api/shares')).data.links;
  assert.strictEqual(any.length, 10);
  assert.strictEqual((await owner('DELETE', '/api/canon')).status, 200);
  assert.deepStrictEqual((await owner('GET', '/api/shares')).data.links, []);
});

test('share links: wrong codes are counted per address - 30 misses and that address waits', async () => {
  const guesser = client();
  for (let i = 0; i < 30; i++) {
    const code = `guess${String(i).padStart(17, '0')}`;
    assert.strictEqual((await guesser('GET', `/api/s/${code}`)).status, 404);
  }
  const blocked = await guesser('GET', '/api/s/guess00000000000000099');
  assert.deepStrictEqual([blocked.status, /Too many tries/.test(blocked.data.error)], [429, true]);
  assert.strictEqual((await client()('GET', '/api/s/guess00000000000000099')).status, 404, 'another address is not blocked');
  assert.strictEqual((await guesser('GET', '/api/s/<script>')).status, 429);
});

test('draft over HTTP: checked before spend, one forced tool, ONLY the parsed schema reaches the model, unknown columns dropped, nothing stored', async () => {
  const ana = await register('ana.draft');
  const calls = await modelCalls();
  for (const bad of [{}, { tables: [] }, { tables: [{ name: 'x', columns: [] }] }, { tables: 'orders' }, []]) assert.strictEqual((await ana('POST', '/api/draft', bad)).status, 400, JSON.stringify(bad));
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const body = draftBody();
  body.raw = 'RAW_SCHEMA_MARKER'; body.system = 'SYSTEM_OVERRIDE_MARKER'; body.tables[0].columns.push({ name: 'col with space', type: 'x' }); body.tables[0].secret = 'TABLE_EXTRA_MARKER';
  const n0 = fakeClient.calls.length;
  const r = await ana('POST', '/api/draft', body);
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const req = fakeClient.calls[n0];
  assert.strictEqual(req.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'propose_metrics' });
  const sent = JSON.stringify(req);
  for (const m of ['RAW_SCHEMA_MARKER', 'SYSTEM_OVERRIDE_MARKER', 'TABLE_EXTRA_MARKER', 'col with space']) assert.ok(!sent.includes(m), `${m} reached the model`);
  assert.ok(sent.includes('Table orders (key id): id int, customer_id int, status text'));
  assert.ok(sent.includes('<<<SCHEMA') && sent.includes('<<<BUSINESS'), 'fenced as untrusted data');
  assert.deepStrictEqual(r.data.metrics.map((m) => m.name), ['Revenue', 'orders count'], 'the made-up-column metric is dropped');
  assert.deepStrictEqual(r.data.metrics[0].filters.map((f) => f.sql), ["orders.status = 'paid'"]);
  assert.deepStrictEqual(r.data.metrics[0].dimensions, ['orders.channel']);
  assert.ok(r.data.dropped.some((d) => d.metric === 'Gross margin') && r.data.dropped.some((d) => /is_internal/.test(d.what)) && r.data.dropped.some((d) => /no_such_dimension/.test(d.what)));
  assert.deepStrictEqual(r.data.sent, { tables: 2, columns: 8 });
  assert.ok(!store._dump().includes('Gross margin') && !store._dump().includes('coffee'), 'nothing stored');
  const inj = await ana('POST', '/api/draft', { ...draftBody(), business: 'INJECT' });
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]|\u202e|javascript:/i.test(inj.text), 'no markup, bidi or script URL reaches the page');
  assert.ok(inj.data.metrics.length <= C.LIMITS.draftMetrics);
  assert.ok(!inj.data.metrics.some((m) => /DROP TABLE/.test(m.measure)), 'a measure with a statement break is refused');
  const blank = await ana('POST', '/api/draft', { ...draftBody(), business: 'BLANK' });
  assert.deepStrictEqual([blank.status, /nothing usable/.test(blank.data.error)], [422, true]);
  assert.match((await ana('POST', '/api/draft', { ...draftBody(), business: 'MAXTOKENS' })).data.error, /ran long/);
  const up = await ana('POST', '/api/draft', { ...draftBody(), business: 'UPSTREAM401' });
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await ana('POST', '/api/draft', { ...draftBody(), business: 'UPSTREAM529' });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('explain over HTTP: only the question, the SQL and the matched definitions reach the model; the answer is cleaned', async () => {
  const sam = await register('sam.explain');
  const calls = await modelCalls();
  assert.strictEqual((await sam('POST', '/api/explain', { sql: 'SELECT 1', metrics: [] })).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const body = explainBody();
  body.canon = CANON(); body.schema = 'SCHEMA_MARKER'; body.metrics[0].secret = 'METRIC_EXTRA_MARKER';
  const n0 = fakeClient.calls.length;
  const r = await sam('POST', '/api/explain', body);
  assert.strictEqual(r.status, 200, r.text);
  const req = fakeClient.calls[n0];
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'explain_answer' });
  const sent = JSON.stringify(req);
  for (const m of ['SCHEMA_MARKER', 'METRIC_EXTRA_MARKER', 'Refund rate', 'Active customers', 'roast', 'Priya']) assert.ok(!sent.includes(m), `${m} reached the model`);
  assert.ok(sent.includes('<<<SQL') && sent.includes('SUM(ol.net_amount)') && sent.includes('## Revenue'));
  assert.strictEqual(r.data.explanation.verdict, 'differs');
  assert.ok(r.data.explanation.differences.length >= 2, 'the fake reads the rules\u2019 two missing filters');
  const inj = await sam('POST', '/api/explain', { ...explainBody(), question: 'INJECT' });
  assert.strictEqual(inj.status, 200);
  assert.ok(!/<[a-z/!]|\u202e|javascript:/i.test(inj.text));
  assert.strictEqual(inj.data.explanation.verdict, 'unclear', 'an unknown verdict becomes unclear');
  assert.ok(inj.data.explanation.differences.length <= 8 && inj.data.explanation.computes.length <= 900);
  assert.strictEqual((await sam('POST', '/api/explain', { ...explainBody(), question: 'BLANK' })).status, 422);
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    for (const p of ['/api/draft', '/api/explain']) {
      const r = await eve('POST', p, p === '/api/draft' ? draftBody() : explainBody());
      assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email'], p);
      assert.strictEqual(r.data.resend, '/canon/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
      assert.strictEqual((await eve('POST', p, BIG)).status, 403, `${p}: 403 before the big body is read`);
    }
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  for (const p of ['/api/draft', '/api/explain']) {
    assert.strictEqual((await cal('POST', p, p === '/api/draft' ? draftBody() : explainBody())).status, 402, p);
    assert.strictEqual((await cal('POST', p, BIG)).status, 402, `${p}: 402, not 413`);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-canon-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    for (const p of ['/api/draft', '/api/explain']) {
      const capped = await dan('POST', p, p === '/api/draft' ? draftBody() : explainBody());
      assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true], p);
      assert.strictEqual((await dan('POST', p, BIG)).status, 503, `${p}: the ceiling answers before the parser too`);
    }
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-canon-${day}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/canon', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/canon`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
