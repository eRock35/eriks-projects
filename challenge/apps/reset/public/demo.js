/* Reset - the made-up example. Quillmere Community Bank is invented, and so
 * is every loan in its book: nicknames only, as Reset keeps them, and
 * numbers picked so each loan shows a different rule binding:
 *
 *   Maple duplex 5/6       a FIRST change held by the first-change cap
 *   Harbor St condo 7/1    the periodic cap (up)
 *   Orchard six-plex       rounding (7.06234% to the nearest 1/8 is 7.000%)
 *   Cedar Ridge lot        the floor, after the index went below zero
 *   Mill building          the lifetime cap
 *   Quarry Road warehouse  the ceiling, under the lifetime cap
 *   Kestrel 3/1 IO         interest-only (6.125%, $765.63)
 *
 * Never kept, sent or synced. No clock: every time is D.T plus a constant.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./reset-core'));
  else root.ResetDemo = factory(root.ResetCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var T = 1795000000000;
  var NAME = 'Quillmere Community Bank';
  var NOTICE = 'Made-up example: Quillmere Community Bank and its loans are invented. Nothing here is kept or sent.';

  function L(nick, f) {
    var F = Object.assign(C.emptyFields(), { nick: nick, first: '0', lookback: '45', every: '12', round: 'nearest', step: '0.125', payRound: 'nearest', io: '0' }, f);
    var r = C.loanFrom(F, T);
    if (r.errors.length) throw new Error('demo loan ' + nick + ': ' + r.errors[0].msg);
    r.loan.what = C.defaultWhat();
    return r.loan;
  }
  var LOANS = {
    lmaple0001: function () { return L('Maple duplex 5/6', { rate: '3.25', start: '3.25', bal: '250000.00', months: '300', index: '4.3', first: '1', date: '2026-12-01', name: '30-day average SOFR', margin: '2.75', every: '6', firstCap: '2', periodicCap: '1', lifetimeCap: '5', floor: '2.75' }); },
    lharbor001: function () { return L('Harbor St condo 7/1', { rate: '5', start: '4.5', bal: '180000.00', months: '264', index: '5.1', date: '2027-01-01', name: '1-year Treasury (CMT)', margin: '2.75', periodicCap: '2', lifetimeCap: '5', floor: '2.75' }); },
    lorchard01: function () { return L('Orchard six-plex', { rate: '6.5', start: '5.875', bal: '200000.00', months: '300', index: '4.31234', date: '2026-12-15', name: '30-day average SOFR', margin: '2.75', every: '6', periodicCap: '1', lifetimeCap: '5', floor: '2.75' }); },
    lcedar0001: function () { return L('Cedar Ridge lot', { rate: '3', start: '3.5', bal: '95000.00', months: '180', index: '-0.15', date: '2027-02-01', name: 'Made-up regional cost-of-funds index', margin: '2.25', periodicCap: '1', floor: '2.5', ceiling: '9' }); },
    lmill00001: function () { return L('Mill building', { rate: '8', start: '4', bal: '320000.00', months: '276', index: '6.6', date: '2027-01-15', name: '1-year Treasury (CMT)', margin: '2.75', periodicCap: '2', lifetimeCap: '5' }); },
    lquarry001: function () { return L('Quarry Road warehouse', { rate: '8', start: '4', bal: '320000.00', months: '276', index: '6.6', date: '2027-03-01', name: '1-year Treasury (CMT)', margin: '2.75', periodicCap: '2', lifetimeCap: '5', ceiling: '8.5' }); },
    lkestrel01: function () { return L('Kestrel 3/1 IO', { rate: '6', start: '5.5', bal: '150000.00', months: '300', index: '3.375', date: '2026-12-20', name: '30-day average SOFR', margin: '2.75', periodicCap: '2', lifetimeCap: '5', floor: '2.75', io: '1' }); },
  };
  function book() {
    var b = C.newBook(T);
    Object.keys(LOANS).forEach(function (id) { b.loans[id] = LOANS[id](); });
    return b;
  }

  // The example note: an invented rate-change section with no name or loan
  // number in it, and the reading a model might have made of it - with a
  // borrower's name, a loan number and a balance among the fields, which
  // the same check as a real reading drops.
  var NOTE_LINES = [
    '4. INTEREST RATE AND MONTHLY PAYMENT CHANGES',
    '(A) Change Dates. The interest rate may change on the first',
    'day of December, 2026, and every 6th month after that.',
    '(B) The Index. 30-day average SOFR, as most recently',
    'available 45 days before each Change Date.',
    '(C) Calculation. The Note Holder adds 2.750 percentage points',
    'and rounds to the nearest one-eighth of one percentage',
    'point (0.125%).',
    '(D) Limits. At the first Change Date the rate will not change',
    'by more than 2.000 points; after that, never more than 1.000',
    'point at a time, never more than 5.000 points above the',
    'initial rate, and never less than 2.750%.',
  ];
  var NOTE_TEXT = NOTE_LINES.join('\n');
  var NOTE_RAW = {
    index_name: '30-day average SOFR', margin: '2.750%', rounding: 'nearest', increment: '0.125%', lookback_days: 45, reset_every_months: 6,
    first_change_cap: '2.000', periodic_cap: '1.000', lifetime_cap: '5.000', floor: '2.750%', ceiling: '', interest_only: false, unsure: ['ceiling'],
    borrower: 'Pat Example', loan_number: ['00', '4471', '2289'].join(''), balance: '$250,000.00',
  };
  function noteSvg() {
    var y = 54, rows = NOTE_LINES.map(function (l, i) {
      var out = '<text x="28" y="' + y + '" font-size="' + (i ? 15 : 16) + '"' + (i ? '' : ' font-weight="700"') + ' fill="#2b2b2b">' + C.esc(l) + '</text>';
      y += i ? 24 : 30;
      return out;
    }).join('');
    return '<svg class="notesvg" viewBox="0 0 560 360" role="img" aria-label="A made-up page of a loan note: the rate-change section"><rect x="4" y="4" width="552" height="352" rx="6" fill="#fbf8f1" stroke="#c9bfa8"/><text x="28" y="30" font-size="12" fill="#5a5243">ADJUSTABLE RATE NOTE · made-up example · page 2</text>' + rows + '</svg>';
  }

  var CSV = [
    'nickname,balance,rate,months,index,margin,rounding,increment,periodic_cap,first_change_cap,lifetime_cap,start_rate,floor,ceiling,first_change,interest_only',
    'Birch Lane fourplex,212450.18,5.875,288,4.31234,2.75,nearest,0.125,1,,5,5.25,2.75,,no,no',
    'Willow Creek 5/6,318900.00,3.5,300,4.3,2.75,nearest,0.125,1,2,5,3.5,2.75,,yes,no',
    'Granary lofts,145000.00,7.25,240,3.1,2.25,nearest,0.125,1,,6,5,2.25,,no,no',
    'Ferry Street retail,410000.00,6,330,2.9,3,up,0.125,2,,5,4,3,7.5,no,no',
    'Linda Example,99000.00,5,200,4,2.75,nearest,0.125,1,,,,,,no,no',
    'Pier 9 storage,88000.00,6.5,120,4.1,,nearest,0.125,1,,,,,,no,no',
    'Aspen IO line,120000.00,6.25,180,3.6,2.5,nearest,0.125,2,,5,4.5,2.5,,no,yes',
  ].join('\n') + '\n';

  return { T: T, NAME: NAME, NOTICE: NOTICE, book: book, NOTE_TEXT: NOTE_TEXT, NOTE_RAW: NOTE_RAW, noteSvg: noteSvg, CSV: CSV };
}));
