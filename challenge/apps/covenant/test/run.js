// Pure rules first, then end to end against the memory store and the fake
// model:
//   COVENANT_MEMORY=1 COVENANT_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /covenant, the way
// the lab mounts it, so the auth cookie, the budget gate, per-owner scoping
// and the two big-body routes are exercised as deployed. Model calls are
// counted from the identity's usage rows - the same rows that bill a real
// account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.COVENANT_MEMORY !== '1' || process.env.COVENANT_FAKE_AI !== '1') {
  console.error('run with COVENANT_MEMORY=1 COVENANT_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const C = require('../public/covenant-core');
const Sample = require('../public/sample');
const ai = require('../lib/ai');
const L = require('../lib/loans');
const fakeai = require('../lib/fakeai');

let base;
function client() {
  const cookies = {};
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
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
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15)); // the meter writes usage rows fire-and-forget
const jpeg = (s = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(s), Buffer.alloc(2000, 7)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- helpers for the pure half ---------------- */

const cov = (metric, op, value, unit = 'x', extra = {}) => C.cleanCovenant({ kind: 'financial', title: metric, plain: 'x', metric, threshold: { op, value, unit }, ...extra });
const $ = (dollars) => String(dollars);
function ev(c, inputs) { const r = C.evaluate({ ...c, id: 'c1' }, inputs); return r; }

/* ---------------- pure: money ---------------- */

test('money is read from the digits, never a float; negatives only where allowed', () => {
  assert.deepStrictEqual(['$1,234.56', '1234.5', '0.1', 'USD 12', '12.345', '12.344', '.5', ' 7 ', '126,300'].map((v) => C.toCents(v)), [123456, 123450, 10, 1200, 1235, 1234, 50, 700, 12630000]);
  assert.strictEqual(C.toCents(0.1 + 0.2), 30, 'a float is read through its digits');
  for (const bad of ['-5', '(12.00)', 'ten', '', '1e5', '$', '12,34.5.6', NaN, Infinity, {}, null]) assert.strictEqual(C.toCents(bad), null, String(bad));
  assert.strictEqual(C.toCents('-1,200', true), -120000);
  assert.strictEqual(C.toCents('(1,200.50)', true), -120050);
  assert.strictEqual(C.toCents('99999999999999'), null, 'over $10B is refused');
  assert.strictEqual(C.money(12630000, true), '$126,300');
  assert.strictEqual(C.money(-5, false), '−$0.05');
  assert.strictEqual(C.plainMoney(12630050), '126,300.50');
  assert.deepStrictEqual(C.cleanInputs({ ebitda: '-4,000', debtService: '-5', cash: 'abc', bogus: '1' }), { ebitda: -400000, debtService: null, totalDebt: null, fixedCharges: null, currentAssets: null, currentLiabilities: null, netWorth: null, cash: null });
});

/* ---------------- pure: the health check ---------------- */

test('DSCR: pass, tight within 10%, breach - with headroom both ways, in dollars', () => {
  const c = cov('dscr', '>=', 1.25);
  const pass = ev(c, { ebitda: $('200,000'), debtService: $('100,000') });
  assert.strictEqual(pass.status, 'pass');
  assert.strictEqual(pass.valueText, '2.00x');
  assert.strictEqual(pass.headroom, 'EBITDA could fall by $75,000 (37%) before DSCR drops below 1.25x.');
  assert.strictEqual(pass.also, 'Or debt service could rise by $60,000 (60%).');
  assert.match(pass.formula, /EBITDA \$200,000 ÷ debt service \$100,000 = 2\.00x/);
  const tight = ev(c, { ebitda: '126,300', debtService: '96,400' });
  assert.deepStrictEqual([tight.status, tight.valueText], ['tight', '1.31x']);
  assert.strictEqual(tight.headroom, 'EBITDA could fall by $5,800 (4%) before DSCR drops below 1.25x.');
  const breach = ev(c, { ebitda: '110,000', debtService: '100,000' });
  assert.strictEqual(breach.status, 'breach');
  assert.strictEqual(breach.headroom, 'DSCR is under 1.25x. EBITDA would need to be $15,000 higher, or debt service $12,000 lower, to meet it.');
  // The tight band's edge: 1.375x is 10% over 1.25x.
  assert.strictEqual(ev(c, { ebitda: '137,499.99', debtService: '100,000' }).status, 'tight');
  assert.strictEqual(ev(c, { ebitda: '137,500', debtService: '100,000' }).status, 'pass');
});

test('exactly on the line passes a >= test and fails a > test; display never rounds a breach up', () => {
  const ge = cov('dscr', '>=', 1.25), gt = cov('dscr', '>', 1.25);
  const on = { ebitda: '125,000', debtService: '100,000' };
  assert.strictEqual(ev(ge, on).status, 'tight');
  assert.strictEqual(ev(ge, on).headroom, 'EBITDA could fall by $0 (under 1%) before DSCR drops below 1.25x.');
  assert.strictEqual(ev(gt, on).status, 'breach');
  assert.match(ev(gt, on).headroom, /\$1 higher/, 'one cent short rounds UP to a dollar to fix');
  const justUnder = ev(ge, { ebitda: '124,999.99', debtService: '100,000' });
  assert.deepStrictEqual([justUnder.status, justUnder.valueText], ['breach', '1.24x'], 'a minimum is shown rounded down');
  const lev = ev(cov('leverage', '<=', 3), { totalDebt: '300,000.01', ebitda: '100,000' });
  assert.deepStrictEqual([lev.status, lev.valueText], ['breach', '3.01x'], 'a maximum is shown rounded up');
});

test('leverage (a maximum): debt you could add, EBITDA that could fall, and what to pay down', () => {
  const c = cov('leverage', '<=', 3);
  const r = ev(c, { totalDebt: '318,000', ebitda: '126,300' });
  assert.deepStrictEqual([r.status, r.valueText], ['pass', '2.52x']);
  assert.strictEqual(r.headroom, 'You could add $60,900 of debt before leverage goes above 3.0x.');
  assert.strictEqual(r.also, 'Or EBITDA could fall by $20,300 (16%).');
  assert.strictEqual(ev(c, { totalDebt: '280,000', ebitda: '100,000' }).status, 'tight', '2.8x is within 10% of 3.0x');
  assert.strictEqual(ev(c, { totalDebt: '270,000', ebitda: '100,000' }).status, 'pass');
  const b = ev(c, { totalDebt: '350,000', ebitda: '100,000' });
  assert.strictEqual(b.headroom, 'Leverage is over 3.0x. You’d need to pay down $50,000 of debt, or grow EBITDA by $16,667, to meet it.');
  // A percentage threshold is the same ratio: 300% is 3.0x.
  assert.strictEqual(ev(cov('leverage', '<=', 300, '%'), { totalDebt: '350,000', ebitda: '100,000' }).status, 'breach');
});

test('current ratio, fixed charge coverage, net worth and liquidity', () => {
  const cr = ev(cov('current_ratio', '>=', 1.2), { currentAssets: '184,000', currentLiabilities: '92,000' });
  assert.deepStrictEqual([cr.status, cr.valueText], ['pass', '2.00x']);
  assert.strictEqual(cr.headroom, 'Current assets could fall by $73,600 (40%) before the current ratio drops below 1.2x.');
  assert.strictEqual(cr.also, 'Or current liabilities could rise by $61,333 (66%).', 'rounded down to the dollar');
  const fc = ev(cov('fixed_charge', '>=', 1.1), { ebitda: '100,000', fixedCharges: '95,000' });
  assert.deepStrictEqual([fc.status, fc.valueText], ['breach', '1.05x']);
  assert.match(fc.formula, /EBITDA \$100,000 ÷ fixed charges \$95,000/);
  const nw = cov('min_net_worth', '>=', 250000, '$');
  const nwr = ev(nw, { netWorth: '300,000' });
  assert.deepStrictEqual([nwr.status, nwr.valueText], ['pass', '$300,000']);
  assert.strictEqual(nwr.headroom, 'Net worth could fall by $50,000 (16%) before it drops below the $250,000 minimum.');
  assert.strictEqual(ev(nw, { netWorth: '260,000' }).status, 'tight');
  const neg = ev(nw, { netWorth: '-20,000' });
  assert.deepStrictEqual([neg.status, neg.headroom], ['breach', 'Net worth is $270,000 short of what the covenant allows.']);
  const liq = ev(cov('min_liquidity', '>=', 50000, '$'), { cash: '49,999.50' });
  assert.deepStrictEqual([liq.status, liq.headroom], ['breach', 'Cash is $1 short of what the covenant allows.']);
});

test('divide by zero, a negative denominator, missing inputs and odd covenants never throw', () => {
  const dscr = cov('dscr', '>=', 1.25);
  const zero = ev(dscr, { ebitda: '100', debtService: '0' });
  assert.strictEqual(zero.status, 'cant');
  assert.match(zero.headroom, /Debt service is \$0/);
  const negEbitda = ev(cov('leverage', '<=', 3), { totalDebt: '100,000', ebitda: '-5,000' });
  assert.strictEqual(negEbitda.status, 'cant');
  assert.match(negEbitda.headroom, /negative.*Lenders usually treat that as failing/);
  const lossYear = ev(dscr, { ebitda: '-5,000', debtService: '10,000' });
  assert.deepStrictEqual([lossYear.status, lossYear.valueText], ['breach', '−0.50x'], 'a loss is a breach of a minimum, not an error');
  const missing = ev(dscr, { ebitda: '100,000', debtService: '' });
  assert.deepStrictEqual([missing.status, missing.need], ['missing', ['debtService']]);
  assert.strictEqual(missing.headroom, 'Enter debt service to check this.');
  assert.deepStrictEqual(ev(dscr, {}).need, ['ebitda', 'debtService']);
  assert.strictEqual(ev(cov('dscr', '>=', 250000, '$'), { ebitda: '1', debtService: '1' }).status, 'cant', 'a ratio test written in dollars');
  assert.strictEqual(ev(cov('min_net_worth', '>=', 2, 'x'), { netWorth: '1' }).status, 'cant');
  assert.strictEqual(ev(C.cleanCovenant({ kind: 'financial', title: 'x', metric: 'other', threshold: { op: '>=', value: 1, unit: 'x' } }), {}).status, 'manual');
  assert.strictEqual(ev(C.cleanCovenant({ kind: 'financial', title: 'x', metric: 'dscr', threshold: null }), {}).status, 'cant');
  assert.strictEqual(ev(C.cleanCovenant({ kind: 'reporting', title: 'x' }), {}).status, 'manual');
  const h = C.health([dscr, cov('current_ratio', '>=', 1.2), C.cleanCovenant({ kind: 'reporting', title: 'r' })], { ebitda: '126,300', debtService: '96,400' });
  assert.deepStrictEqual(h.counts, { pass: 0, tight: 1, breach: 0, missing: 1, cant: 0, manual: 0 });
});

test('only the fields a loan’s tests need are asked for, in form order', () => {
  assert.deepStrictEqual(C.fieldsFor([cov('current_ratio', '>=', 1.2), cov('dscr', '>=', 1.25)]), ['ebitda', 'debtService', 'currentAssets', 'currentLiabilities']);
  assert.deepStrictEqual(C.fieldsFor([cov('min_liquidity', '>=', 1, '$'), C.cleanCovenant({ kind: 'negative', title: 'x' })]), ['cash']);
  assert.deepStrictEqual(C.fieldsFor([]), []);
});

test('periods sort by time and history feeds the sparkline', () => {
  assert.deepStrictEqual(['2026 q3', ' 2025  fy ', '2026 Q5', '1800 Q1', 'Q3 2026'].map(C.cleanPeriod), ['2026 Q3', '2025 FY', null, null, null]);
  assert.deepStrictEqual(C.sortPeriods(['2026 Q1', '2025 FY', '2025 Q4', '2024 FY']), ['2024 FY', '2025 Q4', '2025 FY', '2026 Q1']);
  const periods = {};
  for (const [k, v] of Object.entries(Sample.PERIODS)) periods[k] = { inputs: v };
  const h = C.history(cov('dscr', '>=', 1.25), periods);
  assert.deepStrictEqual(h.map((x) => x.text), ['1.64x', '1.46x', '1.36x', '1.31x']);
  assert.deepStrictEqual(h.map((x) => x.status), ['pass', 'pass', 'tight', 'tight']);
});

/* ---------------- pure: deadlines and the calendar ---------------- */

const reporting = (days, of, extra) => C.cleanCovenant({ kind: 'reporting', title: `R ${days} ${of}`, plain: 'x', dueRule: { daysAfter: days, of, ...extra } });

test('deadlines from the fiscal year end: across year ends, quarters, months', () => {
  const covs = C.cleanCovenants(Sample.RAW).covenants;
  const d = C.deadlines(covs, { today: '2026-09-28', fyeMonth: 12 });
  const annual = d.filter((x) => /Annual/.test(x.title));
  assert.deepStrictEqual(annual.map((x) => x.due), ['2027-04-30'], '120 days after Dec 31, 2026 is Apr 30, 2027');
  assert.strictEqual(annual[0].rule, '120 days after fiscal year end (Dec 31, 2026)');
  assert.deepStrictEqual(d.filter((x) => /Quarterly/.test(x.title)).map((x) => x.due), ['2026-11-14', '2027-05-15', '2027-08-14'], 'the fourth quarter is skipped: the annual covers it');
  const monthly = d.filter((x) => /borrowing base/.test(x.title));
  assert.strictEqual(monthly.length, 12);
  assert.strictEqual(monthly[0].due, '2026-10-20');
  assert.strictEqual(d[0].due, '2026-10-20', 'soonest first');
  assert.strictEqual(C.inWords(d[0].inDays), 'In 3 weeks');
  assert.ok(d.every((x) => x.due >= '2026-09-28' && x.due <= '2027-09-29'));
  const each = C.nextEach(d);
  assert.deepStrictEqual(each.map((x) => x.next.due), ['2026-10-20', '2026-11-14', '2027-04-30']);
  assert.strictEqual(each[0].later.length, 11);
  // A June fiscal year: quarters end Sep, Dec, Mar, Jun.
  const june = C.deadlines([reporting(45, 'quarter_end')], { today: '2026-09-28', fyeMonth: 6 });
  assert.deepStrictEqual(june.map((x) => x.periodEnd), ['2026-09-30', '2026-12-31', '2027-03-31', '2027-06-30']);
  assert.strictEqual(june[3].rule, '45 days after fiscal year end (Jun 30, 2027)');
  // Due today counts; yesterday does not.
  assert.strictEqual(C.deadlines([reporting(20, 'month_end')], { today: '2026-10-20', fyeMonth: 12 })[0].due, '2026-10-20');
  assert.strictEqual(C.deadlines([reporting(20, 'month_end')], { today: '2026-10-21', fyeMonth: 12 })[0].due, '2026-11-20');
});

test('leap years: February fiscal year ends and due dates that cross Feb 29', () => {
  assert.strictEqual(C.monthEnd(2028, 2), '2028-02-29');
  assert.strictEqual(C.monthEnd(2027, 2), '2027-02-28');
  assert.strictEqual(C.monthEnd(2100, 2), '2100-02-28', '2100 is not a leap year');
  const feb = C.deadlines([reporting(90, 'fiscal_year_end')], { today: '2027-09-01', fyeMonth: 2, days: 400 });
  assert.deepStrictEqual(feb.map((x) => [x.periodEnd, x.due]), [['2028-02-29', '2028-05-29']]);
  // 60 days after Dec 31, 2027 lands on Feb 29, 2028; after Dec 31, 2026 on Mar 1, 2027.
  assert.strictEqual(C.deadlines([reporting(60, 'fiscal_year_end')], { today: '2027-06-01', fyeMonth: 12 })[0].due, '2028-02-29');
  assert.strictEqual(C.deadlines([reporting(60, 'fiscal_year_end')], { today: '2026-06-01', fyeMonth: 12 })[0].due, '2027-03-01');
  assert.strictEqual(C.cleanFye(13), 12, 'a bad month falls back to December');
});

test('the .ics file is valid RFC 5545: CRLF, all-day events, reminders, escaping, folding, stable UIDs', () => {
  const items = C.deadlines([C.cleanCovenant({ kind: 'reporting', title: 'Annual statements; CPA, reviewed \\ signed', plain: 'x', section: '5.2(a)', dueRule: { daysAfter: 1, of: 'fiscal_year_end' } })], { today: '2026-12-01', fyeMonth: 11, days: 400 });
  // Nov 30 + 1 day = Dec 1, 2026 (today), and Dec 1, 2027.
  const out = C.ics(items, { name: 'Café “loan”, é ✓', loanKey: 'k1', now: '2026-09-28T12:34:56.789Z' });
  assert.ok(out.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(out), 'every line ends in CRLF');
  const lines = out.split('\r\n').slice(0, -1);
  assert.deepStrictEqual([lines[0], lines[1], lines[lines.length - 1]], ['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR']);
  assert.ok(lines.some((l) => l.startsWith('PRODID:')));
  for (const l of lines) assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `folded: ${l}`);
  const unfolded = out.replace(/\r\n /g, '');
  assert.strictEqual((unfolded.match(/^BEGIN:VEVENT$/mg) || []).length, 2);
  assert.strictEqual((unfolded.match(/^END:VEVENT$/mg) || []).length, 2);
  assert.strictEqual((unfolded.match(/^BEGIN:VALARM\r?$/mg) || []).length, 2);
  assert.ok(/^TRIGGER:-P7D\r?$/m.test(unfolded));
  assert.ok(/^DTSTART;VALUE=DATE:20261201\r?$/m.test(unfolded) && /^DTEND;VALUE=DATE:20261202\r?$/m.test(unfolded));
  assert.ok(/^DTSTAMP:20260928T123456Z\r?$/m.test(unfolded));
  assert.ok(unfolded.includes('SUMMARY:Due: Annual statements\\; CPA\\, reviewed \\\\ signed'), 'TEXT escaping');
  assert.ok(unfolded.includes('X-WR-CALNAME:Café “loan”\\, é ✓'), 'UTF-8 survives folding');
  assert.ok(/DESCRIPTION:Due 1 day after fiscal year end \(Nov 30\\, 2026\)\. Section 5\.2\(a\)\.\\nFrom/.test(unfolded), 'a newline is \\n');
  const uids = unfolded.match(/^UID:.*$/mg);
  assert.strictEqual(new Set(uids).size, 2, 'one UID per event');
  assert.deepStrictEqual(C.ics(items, { name: 'Café “loan”, é ✓', loanKey: 'k1', now: '2030-01-01T00:00:00Z' }).replace(/\r\n /g, '').match(/^UID:.*$/mg), uids, 'the same deadline keeps its UID');
  // Across a year end: Dec 31 + 1 is Jan 1.
  const nye = C.ics([{ title: 'x', due: '2026-12-31' }], {});
  assert.ok(/DTEND;VALUE=DATE:20270101/.test(nye));
  assert.strictEqual(C.icsText('a\r\nb\nc;d,e\\f\u0007'), 'a\\nb\\nc\\;d\\,e\\\\f ');
  assert.strictEqual(C.icsFilename('Riverbend <Bakery> Loan!'), 'riverbend-bakery-loan-deadlines.ics');
  assert.ok(!/BEGIN:VEVENT/.test(C.ics([{ title: 'x', due: 'not a date' }], {})), 'an invalid date is skipped');
});

/* ---------------- pure: what a model returns ---------------- */

test('the example: every quote is in its text, and the numbers tell the story', () => {
  const covs = C.cleanCovenants(Sample.RAW).covenants;
  assert.strictEqual(covs.length, 9);
  const found = C.matcher(Sample.TEXT);
  for (const c of covs) assert.ok(found(c.quote), `${c.title}: quote not in the example text`);
  assert.deepStrictEqual(covs.map((c) => c.kind), ['financial', 'financial', 'financial', 'reporting', 'reporting', 'reporting', 'negative', 'negative', 'insurance']);
  assert.ok(/^Example:/.test(Sample.NAME) && /EXAMPLE ONLY/.test(Sample.TEXT), 'labelled as an example');
  const h = C.health(covs, Sample.PERIODS[Sample.PERIOD]);
  assert.deepStrictEqual(h.results.map((r) => r.status), ['tight', 'pass', 'pass'], 'DSCR tight, leverage and current ratio comfortable');
  assert.ok(covs.every((c) => c.explainToCustomer.length > 60), 'every covenant has a customer explanation');
});

test('quotes are matched exactly after normalising whitespace, quotes and dashes', () => {
  const found = C.matcher('The Borrower shall maintain a “Current Ratio” of not less than 1.20 to 1.00 —\n   tested quarterly.');
  assert.ok(found('maintain a "Current Ratio" of not less than 1.20 to 1.00 - tested quarterly.'));
  assert.ok(!found('maintain a "Current Ratio" of not less than 1.25 to 1.00'), 'a changed number is not a match');
  assert.ok(!found('maintain a current ratio of not less than 1.20'), 'case matters');
  assert.ok(!found('Current'), 'too short to prove anything');
  assert.ok(!found('maintain a "Current Ratio" ... tested quarterly.'), 'an elision is not a match');
});

test('hostile model output: markup, huge strings, bad enums, numbers as strings, fabricated quotes', async () => {
  const res = await fakeai.create().messages.create({ tool_choice: { type: 'tool', name: 'record_covenants' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'INJECT' }] }] });
  const raw = res.content[0].input;
  const r = ai.cleanReading(raw, Sample.TEXT, 'text');
  const all = JSON.stringify(r);
  assert.ok(!/<[a-z/!]/i.test(all), 'no markup survives (a "<=" operator is not markup)');
  assert.ok(!/javascript:/i.test(all) || !/href/.test(all));
  assert.strictEqual(r.covenants.length, 4, 'non-objects and empty covenants are dropped');
  assert.strictEqual(r.dropped, 3);
  const [a, b, c, d] = r.covenants;
  assert.strictEqual(a.plain.length, 400, 'bounded');
  assert.strictEqual(a.title, 'alert("t") Debt service coverage');
  assert.deepStrictEqual(a.threshold, { op: '>=', value: 1.25, unit: 'x' }, '"1.25x" read as 1.25');
  assert.strictEqual(a.confidence, 'low', 'an unknown confidence is low');
  assert.strictEqual(a.section, '6.1(a)');
  assert.strictEqual(a.verified, true);
  assert.deepStrictEqual([b.kind, b.metric, b.threshold, b.testedWhen], ['other', null, null, null], 'bad enums fall back; a metric only on a financial covenant');
  assert.deepStrictEqual(b.dueRule, { daysAfter: 120, of: 'fiscal_year_end' }, '"120" as a string still reads');
  assert.strictEqual(b.verified, false, 'a quote that is not in the text is kept, marked unverified');
  assert.deepStrictEqual([c.metric, c.threshold, c.dueRule, c.quote, c.verified, c.section.length], ['other', null, null, '42', false, 40]);
  assert.deepStrictEqual([d.threshold, d.dueRule], [null, null], 'a 900x ratio and a 9999-day deadline are misreadings');
  assert.strictEqual(r.unverified, 3);
  assert.strictEqual(r.loan.borrower.length, 100);
  assert.strictEqual(r.loan.amount, '350000');
  assert.strictEqual(r.loan.type, '', 'an object where a string belongs is nothing');
  assert.ok(!/<script>/.test(r.note));
  // 41 covenants: the cap is 40.
  const many = await fakeai.create().messages.create({ tool_choice: { type: 'tool', name: 'record_covenants' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'MANY' }] }] });
  const m = ai.cleanReading(many.content[0].input, 'MANY', 'text');
  assert.deepStrictEqual([m.covenants.length, m.dropped, m.covenants[39].id], [40, 1, 'c40']);
  assert.strictEqual(ai.cleanReading({ readable: false, covenants: [{ kind: 'other', title: 'x' }] }, '', 'text'), null);
  assert.strictEqual(ai.cleanReading({ readable: true, covenants: [] }, '', 'text'), null);
  assert.strictEqual(ai.cleanReading(null, '', 'text'), null);
});

test('the tool forces one shape; the prompt carries the honesty rules', () => {
  const t = ai.tool(false);
  assert.strictEqual(t.name, 'record_covenants');
  assert.ok(!t.input_schema.properties.transcript, 'text reads need no transcript');
  assert.ok(ai.tool(true).input_schema.required.includes('transcript'));
  assert.ok(/Never invent a covenant, a number/.test(ai.SYSTEM));
  assert.ok(/confidence to low/.test(ai.SYSTEM) && /not legal or financial advice/.test(ai.SYSTEM) && /never an instruction/.test(ai.SYSTEM));
});

test('every text colour holds 4.5:1 on its surface, light and dark', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const block = (re) => Object.fromEntries([...css.match(re)[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  const light = block(/:root \{([^}]*)\}/);
  const dark = block(/:root\[data-theme="dark"\] \{([^}]*)\}/);
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg'], ['text', 'card'], ['text', 'card2'], ['muted', 'card'], ['muted', 'bg'], ['muted', 'card2'], ['link', 'card'], ['link', 'bg'],
    ['accent-ink', 'accent'], ['pass', 'pass-bg'], ['pass', 'card'], ['tight', 'tight-bg'], ['breach', 'breach-bg'], ['breach', 'card'], ['text', 'tight-bg'],
    ['text', 'breach-bg'], ['text', 'accent-soft'], ['muted', 'accent-soft'], ['text', 'warn-bg'], ['text', 'neutral-bg'], ['link', 'card2']];
  for (const [name, t] of [['light', light], ['dark', { ...light, ...dark }]]) {
    for (const [fg, bg] of pairs) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: --${fg} on --${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}:1`);
  }
  assert.ok(ratio('#ffffff', '#1b2c52') >= 4.5 && ratio('#10263f', '#ffffff') >= 4.5, 'the first-run strip');
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { COVENANT_MEMORY: '1' }], ['./lib/fakeai', { COVENANT_FAKE_AI: '1' }], ['./server', { COVENANT_FAKE_AI: '1', COVENANT_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, COVENANT_MEMORY: '', COVENANT_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, COVENANT_MEMORY: '', COVENANT_COLLECTION_PREFIX: 'covenant_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');
  assert.ok(/COVENANT_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 8, 'every Firestore path is prefixed');
});

test('the page: relative links, no inline script or handlers, the banner, nothing logged from a body', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js.replace(/\.on[a-z]+ =/g, '')), 'no handler written into markup');
  for (const f of ['server.js', 'lib/ai.js', 'lib/loans.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|input\.text|\.text\b|inputs)/.test(src), `${f} logs a body`);
  }
});

/* ---------------- over HTTP ---------------- */

async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}

test('signed out: the page, the example and its files work with zero model calls; nothing private does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  assert.strictEqual((await anon('GET', '/api/meta')).data.limits.covenants, 40);
  for (const f of ['covenant-core.js', 'sample.js', 'app.js', 'app.css', 'verify-banner.js', 'icon.svg']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['POST', '/api/read'], ['GET', '/api/loans'], ['POST', '/api/loans'], ['GET', '/api/loans/abcdefghijkl'], ['PATCH', '/api/loans/abcdefghijkl'],
    ['DELETE', '/api/loans/abcdefghijkl'], ['PUT', '/api/loans/abcdefghijkl/periods/2026%20Q3'], ['DELETE', '/api/loans/abcdefghijkl/periods/2026%20Q3']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  const read = await anon('POST', '/api/read', { text: Sample.TEXT });
  assert.strictEqual(read.status, 401, 'reading needs an account');
  // A stranger's 5 MB body is turned away at the door, unread...
  assert.strictEqual((await anon('POST', '/api/read', { photos: [{ type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) }] })).status, 401, 'the gate answers before the big parser');
  // ...and every other route keeps the small limit.
  assert.strictEqual((await anon('PATCH', '/api/loans/abcdefghijkl', { name: 'x'.repeat(200 * 1024) })).status, 413);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the read route’s gates come before its body parser, in order', () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/api/read');
  assert.deepStrictEqual(layer.route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const save = app._router.stack.find((l) => l.route && l.route.path === '/api/loans' && l.route.methods.post);
  assert.deepStrictEqual(save.route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
});

let ana, ben;
let READING;

test('read a pasted agreement: checked before any spend, one metered call, quotes verified, nothing stored', async () => {
  ana = await register('ana.owner@example.com');
  const dump = store._dump();
  let calls = await modelCalls();
  assert.strictEqual((await ana('POST', '/api/read', { text: 'too short' })).status, 400);
  assert.strictEqual((await ana('POST', '/api/read', {})).status, 400);
  assert.strictEqual((await ana('POST', '/api/read', { text: 'x'.repeat(60001) })).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const r = await ana('POST', '/api/read', { text: Sample.TEXT });
  assert.strictEqual(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.text.startsWith(' '), 'the answer streams whitespace first');
  READING = r.data.reading;
  assert.strictEqual(READING.covenants.length, 9);
  assert.strictEqual(READING.unverified, 0);
  assert.ok(READING.covenants.every((c) => c.verified && c.from === 'text'));
  assert.strictEqual(READING.loan.borrower, 'Riverbend Bakery LLC');
  assert.ok(!('transcript' in READING) && !r.text.includes('ARTICLE 8'), 'the text is not sent back');
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  calls += 1;
  const un = await ana('POST', '/api/read', { text: `${Sample.TEXT}\nUNVERIFIED` });
  assert.strictEqual(un.data.reading.unverified, 1);
  const bad = un.data.reading.covenants.find((c) => !c.verified);
  assert.strictEqual(bad.title, 'No dividends over $50,000 a year', 'kept, and marked');
  const inj = await ana('POST', '/api/read', { text: `${Sample.TEXT}\nINJECT` });
  assert.ok(!/<[a-z/!]/i.test(inj.text), 'no markup reaches the page');
  const many = await ana('POST', '/api/read', { text: `${'MANY '.repeat(50)}` });
  assert.strictEqual(many.data.reading.covenants.length, 40);
  const blank = await ana('POST', '/api/read', { text: `${'BLANK '.repeat(50)}` });
  assert.deepStrictEqual([blank.status, /doesn’t read like a loan agreement/.test(blank.data.error)], [200, true], 'after the stream starts, a failure is a 200 {error}');
  assert.match((await ana('POST', '/api/read', { text: 'NOCOVENANTS '.repeat(30) })).data.error, /No covenants were found/);
  assert.match((await ana('POST', '/api/read', { text: 'MAXTOKENS '.repeat(30) })).data.error, /ran longer than one reading/);
  const up = await ana('POST', '/api/read', { text: 'UPSTREAM401 '.repeat(30) });
  assert.ok(up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  assert.strictEqual(store._dump(), dump, 'reading stores nothing');
});

test('read photos: bytes checked before any spend, quotes checked against the transcript', async () => {
  const calls = await modelCalls();
  assert.strictEqual((await ana('POST', '/api/read', { photos: [{ type: 'image/jpeg', data: Buffer.from('%PDF-1.4 not a photo').toString('base64') }] })).status, 400);
  assert.strictEqual((await ana('POST', '/api/read', { photos: Array.from({ length: 7 }, () => ({ type: 'image/jpeg', data: jpeg() })) })).status, 400);
  assert.strictEqual((await ana('POST', '/api/read', { photos: [{ type: 'image/jpeg', data: 'A'.repeat(4 * 1024 * 1024) }] })).status, 400, 'one page over 3 MB');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for bad photos');
  const dump = store._dump();
  const r = await ana('POST', '/api/read', { photos: [{ type: 'image/jpeg', data: jpeg('PAGE1') }, { type: 'image/jpeg', data: jpeg('PAGE2') }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.reading.from, 'photo');
  assert.ok(r.data.reading.covenants.every((c) => c.from === 'photo' && c.verified), 'verified against what was read off the pages');
  assert.ok(!r.text.includes('EXAMPLE ONLY'), 'the transcript is not sent back');
  assert.strictEqual(store._dump(), dump, 'no photo stored');
  const blank = await ana('POST', '/api/read', { photos: [{ type: 'image/jpeg', data: jpeg('BLANK') }] });
  assert.match(blank.data.error, /don’t look like pages of a loan agreement/);
});

test('an unconfirmed free account gets the verify-email 403, before any model call', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/read', { text: Sample.TEXT });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.match(r.data.error, /Confirm your email/);
    assert.strictEqual(r.data.resend, '/covenant/api/auth/verify/send', 'the resend link is under this app’s mount');
    const big = await eve('POST', '/api/read', { photos: [{ type: 'image/jpeg', data: 'A'.repeat(18 * 1024 * 1024) }] });
    assert.strictEqual(big.status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('POST', '/api/loans', { sample: true })).status, 200, 'saving needs no AI and no confirmed address');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
});

test('out of credit: 402 before any model call - and before the big body is read', async () => {
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/read', { text: Sample.TEXT })).status, 402);
  const big = await cal('POST', '/api/read', { photos: [{ type: 'image/jpeg', data: 'A'.repeat(18 * 1024 * 1024) }] });
  assert.strictEqual(big.status, 402, '402, not 413: the budget gate runs before the parser');
  assert.strictEqual((await cal('POST', '/api/loans', { sample: true })).status, 200, 'saving is free');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
});

let LOAN_ID;

test('save a reading: only the structured covenants and numbers are stored, never the agreement', async () => {
  const r = await ana('POST', '/api/loans', { name: '<b>Bakery</b> loan', loan: READING.loan, covenants: READING.covenants, fye: 12, from: 'text', period: '2026 q3', inputs: { ebitda: '126,300', debtService: '96,400', bogus: '5' }, text: Sample.TEXT });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const loan = r.data.loan;
  LOAN_ID = loan.id;
  assert.strictEqual(loan.name, 'Bakery loan');
  assert.deepStrictEqual(Object.keys(loan.periods), ['2026 Q3']);
  assert.deepStrictEqual(loan.periods['2026 Q3'].inputs, { ebitda: 12630000, debtService: 9640000 });
  assert.strictEqual(loan.covenants.length, 9);
  const dump = store._dump();
  for (const bit of ['This Loan Agreement is dated', 'ARTICLE 8', 'EVENTS OF DEFAULT', 'generally accepted accounting principles']) assert.ok(!dump.includes(bit), `the agreement's text is stored: ${bit}`);
  const doc = await store.get(`loans/${uidOf('ana.owner@example.com')}/items`, LOAN_ID);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['covenants', 'createdAt', 'from', 'fye', 'id', 'loan', 'name', 'periods', 'updatedAt']);
  const list = await ana('GET', '/api/loans');
  assert.deepStrictEqual(list.data.loans.map((l) => [l.id, l.covenants, l.latest]), [[LOAN_ID, 9, '2026 Q3']]);
});

test('a saved loan’s body is cleaned like a model’s: markup, bounds, the 40 cap; nothing to save is a 400', async () => {
  const hostile = Array.from({ length: 45 }, (_, i) => ({ kind: i ? 'affirmative' : 'financial', title: `<img src=x onerror=alert(${i})>T${i}`, plain: 'p'.repeat(5000), metric: 'dscr', threshold: { op: '>=', value: '1.25x' }, verified: 'yes' }));
  const r = await ana('POST', '/api/loans', { loan: { lender: '<script>x</script>Bank' }, covenants: hostile, fye: 99 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.loan.covenants.length, 40);
  assert.ok(!/<[a-z/!]/i.test(JSON.stringify(r.data)));
  assert.strictEqual(r.data.loan.covenants[0].plain.length, 400);
  assert.strictEqual(r.data.loan.covenants[0].verified, false, 'only a real true is true');
  assert.strictEqual(r.data.loan.fye, 12);
  assert.strictEqual(r.data.loan.name, 'My business · x Bank');
  assert.strictEqual((await ana('DELETE', `/api/loans/${r.data.loan.id}`)).status, 200);
  assert.strictEqual((await ana('POST', '/api/loans', { covenants: [] })).status, 400);
  assert.strictEqual((await ana('POST', '/api/loans', '{not json')).status, 400);
});

test('periods, rename, fiscal year end; another person’s loan is a 404 everywhere', async () => {
  const P = `/api/loans/${LOAN_ID}`;
  let r = await ana('PUT', `${P}/periods/2025%20FY`, { inputs: { ebitda: '141,000', debtService: '96,400' } });
  assert.deepStrictEqual(Object.keys(r.data.loan.periods), ['2025 FY', '2026 Q3'], 'kept in time order');
  assert.strictEqual((await ana('PUT', `${P}/periods/Q3%202026`, { inputs: { ebitda: '1' } })).status, 400);
  assert.strictEqual((await ana('PUT', `${P}/periods/2026%20Q2`, { inputs: { bogus: '1' } })).status, 400, 'nothing to save');
  r = await ana('PATCH', P, { name: 'Riverbend term loan', fye: 6 });
  assert.deepStrictEqual([r.data.loan.name, r.data.loan.fye], ['Riverbend term loan', 6]);
  assert.strictEqual((await ana('PATCH', P, { fye: 13 })).status, 400);
  assert.strictEqual((await ana('PATCH', P, { name: '<>' })).status, 400);
  r = await ana('DELETE', `${P}/periods/2025%20FY`);
  assert.deepStrictEqual(Object.keys(r.data.loan.periods), ['2026 Q3']);
  assert.strictEqual((await ana('DELETE', `${P}/periods/2025%20FY`)).status, 404);
  ben = await register('ben.other@example.com');
  for (const [m, p, b] of [['GET', P], ['PATCH', P, { name: 'mine now' }], ['DELETE', P], ['PUT', `${P}/periods/2026%20Q4`, { inputs: { ebitda: '1' } }], ['DELETE', `${P}/periods/2026%20Q3`]]) {
    assert.strictEqual((await ben(m, p, b)).status, 404, `${m} ${p}`);
  }
  assert.deepStrictEqual((await ben('GET', '/api/loans')).data.loans, []);
  assert.strictEqual((await ana('GET', P)).data.loan.name, 'Riverbend term loan', 'untouched by the stranger');
  assert.strictEqual((await ana('GET', '/api/loans/..%2F..%2Fx')).status, 404);
});

test('limits: 10 loans a person, 20 periods a loan; delete removes everything', async () => {
  const have = (await ana('GET', '/api/loans')).data.loans.length;
  for (let i = have; i < 10; i++) assert.strictEqual((await ana('POST', '/api/loans', { sample: true })).status, 200);
  const eleventh = await ana('POST', '/api/loans', { sample: true });
  assert.deepStrictEqual([eleventh.status, /up to 10 loans/.test(eleventh.data.error)], [409, true]);
  const sample = (await ana('GET', '/api/loans')).data.loans.find((l) => l.name === 'Riverbend Bakery (example)');
  const full = (await ana('GET', `/api/loans/${sample.id}`)).data.loan;
  assert.strictEqual(Object.keys(full.periods).length, 4, 'the saved example brings its history');
  assert.ok(full.covenants.every((c) => c.verified));
  let n = 4;
  for (let y = 2000; n < 20; y++) { assert.strictEqual((await ana('PUT', `/api/loans/${sample.id}/periods/${y}%20Q1`, { inputs: { ebitda: '1' } })).status, 200); n++; }
  assert.strictEqual((await ana('PUT', `/api/loans/${sample.id}/periods/2030%20FY`, { inputs: { ebitda: '1' } })).status, 409);
  assert.strictEqual((await ana('PUT', `/api/loans/${sample.id}/periods/2000%20Q1`, { inputs: { ebitda: '2' } })).status, 200, 'an existing period can still be updated');
  assert.strictEqual((await ana('DELETE', `/api/loans/${sample.id}`)).status, 200);
  assert.strictEqual(await store.get(`loans/${uidOf('ana.owner@example.com')}/items`, sample.id), null, 'gone');
  assert.strictEqual((await ana('GET', `/api/loans/${sample.id}`)).status, 404);
  assert.strictEqual((await ana('DELETE', `/api/loans/${sample.id}`)).status, 404);
});

test('two saves at once never make an eleventh loan', async () => {
  const dee = await register('dee.race@example.com');
  for (let i = 0; i < 9; i++) await dee('POST', '/api/loans', { sample: true });
  const both = await Promise.all([dee('POST', '/api/loans', { sample: true }), dee('POST', '/api/loans', { sample: true })]);
  assert.deepStrictEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.strictEqual((await dee('GET', '/api/loans')).data.loans.length, 10);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use('/covenant', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/covenant`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
