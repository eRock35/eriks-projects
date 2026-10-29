/* Stray - the example. A MADE-UP credit union, Juniper Valley Credit Union,
 * with an auto-loan book of 30 accounts and a suspense list of 14 payments
 * that show off every signal: an exact match, a number hiding in a memo,
 * leading zeros and a dash, two swapped digits, a one-digit typo, "OKAFOR WM"
 * paying William Okafor's loan, a co-borrower paying with a nickname, two
 * months at once, a payoff, a household paying two loans with one check, a
 * business paying for its owner, two Patels told apart by the amount, and
 * two payments that belong to nobody on the book.
 *
 * Every name, number and amount here is invented; the page labels it
 * "made-up example" wherever it appears. Both files are written as CSV text,
 * with the headers a core banking export might have, so the example goes
 * through exactly the reading, column guessing and matching your own files
 * do. Dates are counted back from the day the page hands in - no clock here.
 *
 * UMD like the core: window.StrayDemo in the page, require() in the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StrayDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NAME = 'Juniper Valley Credit Union';

  // The intended verdict for each suspense item - the tests hold the matcher
  // to exactly these.
  var EXPECT = {
    'JV-4101': 'match', 'JV-4102': 'match', 'JV-4103': 'match', 'JV-4104': 'match', 'JV-4105': 'check',
    'JV-4106': 'match', 'JV-4107': 'match', 'JV-4108': 'match', 'JV-4109': 'match', 'JV-4110': 'split',
    'JV-4111': 'check', 'JV-4112': 'two', 'JV-4113': 'none', 'JV-4114': 'none',
  };
  var SHOWS = {
    'JV-4101': 'An exact match: number, name and amount',
    'JV-4102': 'Leading zeros and a dash in the number',
    'JV-4103': 'The account number hiding in the memo',
    'JV-4104': 'Two digits swapped',
    'JV-4105': 'One digit wrong, and not the usual amount',
    'JV-4106': '“OKAFOR WM” for William Okafor',
    'JV-4107': 'The co-borrower paying, by nickname',
    'JV-4108': 'Two months in one payment',
    'JV-4109': 'A payoff',
    'JV-4110': 'One check for two household loans',
    'JV-4111': 'A business paying for its owner',
    'JV-4112': 'Two Patels, told apart by the amount',
    'JV-4113': 'An invoice for somebody else',
    'JV-4114': 'A mobile deposit with no name',
  };

  // [loan number, borrower, co-borrower, monthly payment, past due, payoff, status, due-day offset (null: fixed day)]
  var BOOK = [
    ['104118', 'Marcus Bell', '', '389.12', '0.00', '11,204.40', 'Current', 1],
    ['104425', 'Priya Raman', '', '412.37', '0.00', '14,980.15', 'Current', 0],
    ['104881', 'Thanh Nguyen', '', '298.55', '0.00', '6,402.90', 'Current', 2],
    ['105327', 'Colette Marchand', '', '455.90', '0.00', '17,733.08', 'Current', 1],
    ['106918', 'Dmitri Volkov', '', '287.40', '0.00', '5,118.64', 'Current', 3],
    ['107264', 'William Okafor', '', '533.18', '0.00', '21,045.77', 'Current', 0],
    ['107733', 'Daniel Chen', 'Elizabeth Chen', '361.25', '0.00', '9,876.30', 'Current', 1],
    ['108052', 'Aisha Rahman', '', '402.66', '402.66', '12,310.48', '30 days late', 2],
    ['108490', 'Gordon Whitcombe', '', '318.40', '0.00', '6,814.22', 'Current', 0],
    ['108811', 'Hector Martinez', '', '344.10', '0.00', '13,402.66', 'Current', 1],
    ['108812', 'Ana Martinez', '', '276.85', '0.00', '8,990.12', 'Current', 1],
    ['109034', 'Luis Martinez', 'Carmen Martinez', '512.00', '0.00', '19,870.00', 'Current', null, 11],
    ['109377', 'Rosa Delgado', '', '468.30', '0.00', '15,222.59', 'Current', 2],
    ['109615', 'Jaya Patel', '', '350.00', '0.00', '10,450.00', 'Current', 0],
    ['109902', 'Jonah Patel', '', '295.00', '350.00', '7,705.35', '30 days late', -2],
    ['110147', 'Ingrid Solberg', '', '299.99', '0.00', '4,402.17', 'Current', null, 5],
    ['110388', 'Kwame Mensah', 'Abena Mensah', '441.20', '0.00', '16,118.90', 'Current', null, 20],
    ['110526', 'Fatima Haddad', '', '377.77', '0.00', '11,980.04', 'Current', null, 15],
    ['110904', 'Oliver Grant', '', '520.00', '0.00', '0.00', 'Paid off', null, 1],
    ['111230', 'Sofia Romano', '', '333.33', '0.00', '8,201.55', 'Current', null, 9],
    ['111467', 'Benjamin Ortiz', '', '289.90', '289.90', '7,340.12', '30 days late', null, 25],
    ['111805', 'Mei Tanaka', '', '410.00', '0.00', '13,900.00', 'Current', null, 3],
    ['112093', 'Ruth Abernathy', '', '256.40', '0.00', '3,118.20', 'Current', null, 18],
    ['112346', 'Tomasz Nowak', '', '395.15', '0.00', '12,644.81', 'Current', null, 7],
    ['112710', 'Lena Fischer', '', '347.60', '0.00', '9,512.44', 'Current', null, 22],
    ['113058', 'Carlos Ruiz', 'Marisol Ruiz', '462.85', '0.00', '18,330.70', 'Current', null, 14],
    ['113392', 'Hannah Brooks', '', '305.25', '0.00', '5,990.18', 'Current', null, 28],
    ['113741', 'Samuel Adeyemi', '', '498.70', '997.40', '20,118.36', '60 days late', null, 10],
    ['114006', 'Nadia Petrova', '', '366.45', '0.00', '10,004.92', 'Current', null, 16],
    ['114359', 'George Kim', '', '419.80', '0.00', '14,276.03', 'Current', null, 12],
  ];

  // [item, days ago, amount, remitter, memo, account as given, method, loan it is really for (for the due day)]
  var SUSPENSE = [
    ['JV-4101', 1, '$389.12', 'MARCUS BELL', 'AUTO PMT', '104118', 'ACH', '104118'],
    ['JV-4102', 2, '$298.55', 'THANH NGUYEN', 'LOAN PAYMENT', '0010-4881', 'Online banking', '104881'],
    ['JV-4103', 3, '$412.37', 'PRIYA RAMAN', 'LN 0104425 OCT PMT', '', 'Bill pay', '104425'],
    ['JV-4104', 4, '$455.90', 'COLETTE MARCHAND', 'CAR LOAN', '105372', 'ACH', '105327'],
    ['JV-4105', 9, '$300.00', 'DMITRI VOLKOV', 'PAYMENT', '106913', 'Check', '106918'],
    ['JV-4106', 5, '$533.18', 'OKAFOR WM', '', '', 'Check', '107264'],
    ['JV-4107', 2, '$361.25', 'LIZ CHEN', 'CAR PAYMENT', '', 'Zelle', '107733'],
    ['JV-4108', 8, '$805.32', 'AISHA RAHMAN', 'OCT + NOV', '108052', 'Online banking', '108052'],
    ['JV-4109', 1, '$6,814.22', 'GORDON WHITCOMBE', 'PAYOFF', '108490', 'Wire', '108490'],
    ['JV-4110', 12, '$620.95', 'HECTOR & ANA MARTINEZ', '2 CAR PMTS', '', 'Check', '108811'],
    ['JV-4111', 18, '$468.30', 'DELGADO LANDSCAPING LLC', 'AUTO LOAN', '', 'Check', '109377'],
    ['JV-4112', 22, '$350.00', 'J PATEL', '', '', 'ACH', '109615'],
    ['JV-4113', 41, '$1,250.00', 'NORTHSIDE AUTO BODY', 'INV 55120 REPAIR', '', 'Wire', ''],
    ['JV-4114', 33, '$187.50', '', 'MOBILE DEPOSIT', '', 'Mobile', ''],
  ];

  function pad2(n) { return ('0' + n).slice(-2); }
  function back(today, n) { return new Date(Date.parse(today + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10); }
  function us(iso) { return +iso.slice(5, 7) + '/' + +iso.slice(8, 10) + '/' + iso.slice(0, 4); }
  function q(v) { return /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v; }
  function clampDay(d) { while (d < 1) d += 28; while (d > 28) d -= 28; return d; }

  /** The two files, as CSV text, for a given "today" (YYYY-MM-DD). */
  function files(today) {
    var recvDay = {};
    SUSPENSE.forEach(function (s) { if (s[7]) recvDay[s[7]] = +back(today, s[1]).slice(8, 10); });
    // Due days sit near the day each matched payment arrived (offset days
    // before it), so the timing check reads the way it would in real life.
    var accounts = ['Loan Number,Borrower,Co-Borrower,Monthly Pmt,Past Due,Payoff,Due Day,Status'];
    BOOK.forEach(function (b) {
      var due = b[7] === null ? b[8] : clampDay((recvDay[b[0]] || 15) - b[7]);
      accounts.push([b[0], b[1], b[2], b[3], b[4], b[5], String(due), b[6]].map(q).join(','));
    });
    var payments = ['Item ID,Rcvd Date,Amount,Remitter,Memo / Reference,Acct # Given,Method'];
    SUSPENSE.forEach(function (s) { payments.push([s[0], us(back(today, s[1])), s[2], s[3], s[4], s[5], s[6]].map(q).join(',')); });
    return {
      payments: { name: 'juniper-valley-suspense.csv', text: payments.join('\r\n') + '\r\n' },
      accounts: { name: 'juniper-valley-auto-loans.csv', text: accounts.join('\r\n') + '\r\n' },
    };
  }

  return { NAME: NAME, EXPECT: EXPECT, SHOWS: SHOWS, files: files, pad2: pad2 };
}));
