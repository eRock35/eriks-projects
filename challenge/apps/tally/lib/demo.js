// The sample a signed-out visitor sees. Everything here is INVENTED:
// "Copper Kettle Coffee", its three weeks of card sales, its bank lines and
// its reference numbers are fictional, and the page says so on every view.
//
// No model call and no write, ever. The page reconciles this data in the
// browser with the same public/rules.js a real account uses, so every status,
// every explanation and every total on the sample is the real arithmetic.
// It is pinned to its own "today" (Sat, Sep 26, 2026) so the story holds
// still: three weeks of a café on Square with
//
//   - weekend and holiday batches: Sat, Sun and Labor Day paid Tuesday in one
//     deposit; every Fri-Sun paid Monday in one;
//   - FEE CREEP: from Monday Sep 14 the payouts are cut at 2.9% + 15¢, not
//     the 2.6% + 15¢ on the plan - every deposit still "matches" within the
//     allowance, which is exactly how creep hides;
//   - a SHORT deposit: Wednesday Sep 16 came in with an $86.40 hold taken out
//     on top of the creep - $90.45 under the plan (a chargeback
//     hold nobody mentioned);
//   - a MISSING batch: Tuesday Sep 22 never arrived;
//   - PENDING: Friday Sep 25 is not due until Monday.

const R = require('../public/rules');

const TODAY = '2026-09-26';
const BUSINESS = 'Copper Kettle Coffee';

const SETTINGS = R.settingsOf({ business: BUSINESS, processor: 'square', feeBps: 260, feeFixedCents: 15, windowDays: 1, tolCents: 200, tolBps: 50, configured: true });

// date, card sales, card tips, refunds, card transactions (dollars as text)
const DAYS = [
  ['2026-09-05', '1862.40', '172.30', '0', 141],
  ['2026-09-06', '1694.75', '158.10', '18.50', 128],
  ['2026-09-07', '1408.20', '121.40', '0', 109],
  ['2026-09-08', '1152.65', '98.75', '0', 91],
  ['2026-09-09', '1219.30', '104.20', '12.00', 95],
  ['2026-09-10', '1301.85', '112.60', '0', 99],
  ['2026-09-11', '1488.10', '131.95', '0', 112],
  ['2026-09-12', '1921.60', '181.40', '24.00', 146],
  ['2026-09-13', '1733.45', '160.25', '0', 131],
  ['2026-09-14', '1097.20', '92.10', '0', 86],
  ['2026-09-15', '1176.90', '101.35', '9.50', 90],
  ['2026-09-16', '1243.75', '107.80', '0', 94],
  ['2026-09-17', '1318.40', '115.30', '0', 101],
  ['2026-09-18', '1512.35', '134.70', '16.25', 115],
  ['2026-09-19', '1955.80', '186.10', '0', 149],
  ['2026-09-20', '1701.20', '157.40', '0', 129],
  ['2026-09-21', '1121.55', '94.60', '0', 88],
  ['2026-09-22', '1284.50', '110.25', '0', 96],
  ['2026-09-23', '1205.10', '103.90', '0', 93],
  ['2026-09-24', '1347.65', '118.45', '22.00', 103],
  ['2026-09-25', '1538.90', '139.20', '0', 118],
].map(([date, gross, tips, refunds, tx]) => ({ date, grossCents: R.toCents(gross), tipsCents: R.toCents(tips), refundsCents: R.toCents(refunds), txCount: tx, note: '', source: 'typed' }));

// Which sale days each payout covered, the day it landed, and the cents the
// processor's own rounding moved it by. The rate the processor ACTUALLY used
// is 2.6% until Sep 13's sales and 2.9% from Sep 14's.
const PAYOUTS = [
  { on: '2026-09-08', days: ['2026-09-05', '2026-09-06', '2026-09-07'], jitter: -2, ref: 'T8K2QF' },
  { on: '2026-09-09', days: ['2026-09-08'], jitter: 1, ref: 'H3M9WD' },
  { on: '2026-09-10', days: ['2026-09-09'], jitter: 0, ref: 'P7N4XC' },
  { on: '2026-09-11', days: ['2026-09-10'], jitter: -1, ref: 'Q2R8JB' },
  { on: '2026-09-14', days: ['2026-09-11', '2026-09-12', '2026-09-13'], jitter: 2, ref: 'V6D3LA' },
  { on: '2026-09-15', days: ['2026-09-14'], jitter: 0, ref: 'B9T5GE' },
  { on: '2026-09-16', days: ['2026-09-15'], jitter: -1, ref: 'Z4C7HK' },
  { on: '2026-09-17', days: ['2026-09-16'], jitter: 0, short: 8640, ref: 'M1F6PS' },
  { on: '2026-09-18', days: ['2026-09-17'], jitter: 1, ref: 'D5W2NR' },
  { on: '2026-09-21', days: ['2026-09-18', '2026-09-19', '2026-09-20'], jitter: -2, ref: 'K8Y3TV' },
  { on: '2026-09-22', days: ['2026-09-21'], jitter: 0, ref: 'G2H7UQ' },
  // Sep 22's payout (due Wed Sep 23) never came.
  { on: '2026-09-24', days: ['2026-09-23'], jitter: 1, ref: 'R6J9CM' },
  { on: '2026-09-25', days: ['2026-09-24'], jitter: -1, ref: 'W3E8YL' },
];
const CREEP_FROM = '2026-09-14';

function actualNet(day) {
  const bps = day.date >= CREEP_FROM ? 290 : 260;
  const charged = day.grossCents + day.tipsCents;
  return charged - day.refundsCents - (Math.round(charged * bps / 10000) + day.txCount * 15);
}
const byDate = Object.fromEntries(DAYS.map((d) => [d.date, d]));
const code = (iso) => iso.slice(2).replace(/-/g, '');

const DEPOSITS = PAYOUTS.map((p, i) => ({
  id: `demo${String(i + 1).padStart(2, '0')}`,
  date: p.on,
  amountCents: p.days.reduce((a, d) => a + actualNet(byDate[d]), 0) + p.jitter - (p.short || 0),
  description: `SQUARE INC DES:SQ${code(p.on)} ID:${p.ref} INDN:COPPER KETTLE COFFEE`,
  source: 'csv',
}));

// A made-up checking-account export in Chase's layout, for the import
// preview: the Square payouts, plus the lines a café's account really has -
// cash paid in, a Zelle, rent, the roaster, payroll - which the keyword
// filter should leave unticked.
function sampleCsv() {
  const lines = [['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #']];
  const other = [
    ['CREDIT', '2026-09-08', 'MOBILE DEPOSIT REF 4471 CASH', '640.00', 'DEPOSIT'],
    ['DEBIT', '2026-09-10', 'ELM STREET PROPERTIES RENT SEP', '-3200.00', 'ACH_DEBIT'],
    ['DEBIT', '2026-09-15', 'RIVERBEND ROASTERS INV 2291', '-842.60', 'ACH_DEBIT'],
    ['CREDIT', '2026-09-18', 'ZELLE FROM J OKAFOR CATERING DEP', '250.00', 'QUICKPAY_CREDIT'],
    ['DEBIT', '2026-09-18', 'GUSTO PAYROLL 091826', '-4186.35', 'ACH_DEBIT'],
    ['DEBIT', '2026-09-22', 'CITY OF MAPLEWOOD WATER', '-118.40', 'ACH_DEBIT'],
    ['CREDIT', '2026-09-23', 'MOBILE DEPOSIT REF 4502 CASH', '515.00', 'DEPOSIT'],
  ];
  const late = lateDeposit();
  const rows = DEPOSITS.concat([late]).map((d) => ['CREDIT', d.date, d.description, R.plain(d.amountCents), 'ACH_CREDIT']).concat(other)
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  let bal = 1843210;
  for (const r of rows) {
    const [y, m, d] = r[1].split('-');
    lines.push([r[0], `${m}/${d}/${y}`, r[2], r[3], r[4], R.plain(bal), '']);
    bal -= R.toCents(r[3], true);
  }
  return lines.map((l) => l.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';
}

/** Everything the sample page needs, plus the reconciliation already done -
 *  the page recomputes it with the same rules, the tests read it from here. */
function demo() {
  const result = R.reconcile(DAYS, DEPOSITS, SETTINGS, TODAY);
  const m = R.month(result, '2026-09');
  return {
    demo: true,
    business: BUSINESS,
    today: TODAY,
    settings: SETTINGS,
    days: DAYS,
    deposits: DEPOSITS,
    csv: sampleCsv(),
    summary: {
      counts: m.counts, totals: m.totals, streak: m.streak, creep: m.creep,
      statuses: Object.fromEntries(result.rows.map((r) => [r.date, r.status])),
      unplaced: result.unplaced.length,
    },
    lateDeposit: lateDeposit(),
  };
}

// "It turned up after all": the late payout for Tuesday Sep 22. It is in the
// sample's bank export but not yet in its books, so the import preview has
// one new line to add - and adding it (there, or from the missing day's card)
// balances the books. Never stored.
function lateDeposit() {
  return {
    id: 'demo-late', date: '2026-09-25', amountCents: actualNet(byDate['2026-09-22']),
    description: `SQUARE INC DES:SQ${code('2026-09-25')} ID:X9A4KD INDN:COPPER KETTLE COFFEE`, source: 'csv',
  };
}

module.exports = { demo, DAYS, DEPOSITS, SETTINGS, TODAY, BUSINESS, CREEP_FROM, sampleCsv, actualNet };
