/* Tieout - the two example statements. Made up: an invented bank and card
 * issuer, an invented coffee shop, account numbers that are only ever last
 * four. Every figure is computed here, so the printed balances and totals are
 * exactly what a real statement would print.
 *
 *   checking  Harbor & Pine Coffee Co., September 2026, 3 pages, a balance
 *             printed after each day. ONE ROW IS MISREAD on purpose: Sysco's
 *             $1,240.00 on Sep 14 was read as $12.40 (a slipped decimal
 *             point), the way a real reading sometimes goes wrong. The checks
 *             catch it, name the row and offer the fix.
 *   card      the same shop's business card, Aug 27 - Sep 26, 2 pages, no
 *             running balance - the statement's own totals and the closing
 *             balance are the proof. It ties out.
 *
 * UMD: window.TieoutSample in the page; require() in the fake model and the
 * tests, which read the same statements as model output (strings, as printed).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tieout-core'));
  else root.TieoutSample = factory(root.TieoutCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  // [date, description, amount in cents (money in +, out -), page]
  var CHECKING = [
    ['2026-09-01', 'SQUARE INC DEPOSIT SQ260901', 128455, 1],
    ['2026-09-01', 'GUSTO PAYROLL NET PAY', -681240, 1],
    ['2026-09-02', 'SQUARE INC DEPOSIT SQ260902', 110280, 1],
    ['2026-09-02', 'PG&E WEB ONLINE UTILITY', -48621, 1],
    ['2026-09-03', 'SQUARE INC DEPOSIT SQ260903', 96835, 1],
    ['2026-09-03', 'CHECK 1043', -75000, 1],
    ['2026-09-04', 'SQUARE INC DEPOSIT SQ260904', 141560, 1],
    ['2026-09-04', 'SYSCO FOOD SERVICES ACH', -231877, 1],
    ['2026-09-05', 'SQUARE INC DEPOSIT SQ260905', 187610, 1],
    ['2026-09-08', 'SQUARE INC DEPOSIT SQ260908', 264425, 1],
    ['2026-09-08', 'HARBOR PROPERTIES RENT', -420000, 1],
    ['2026-09-09', 'SQUARE INC DEPOSIT SQ260909', 105640, 1],
    ['2026-09-09', 'COMCAST BUSINESS', -18999, 1],
    ['2026-09-10', 'SQUARE INC DEPOSIT SQ260910', 119005, 2],
    ['2026-09-10', 'ODEKO DAIRY SUPPLY', -61248, 2],
    ['2026-09-11', 'SQUARE INC DEPOSIT SQ260911', 132270, 2],
    ['2026-09-11', 'STRIPE TRANSFER CATERING', 86000, 2],
    ['2026-09-14', 'SQUARE INC DEPOSIT SQ260914', 290315, 2],
    ['2026-09-14', 'SYSCO FOOD SERVICES ACH', -124000, 2],
    ['2026-09-14', 'CITY OF OAKLAND BUS TAX', -9500, 2],
    ['2026-09-15', 'GUSTO PAYROLL NET PAY', -679012, 2],
    ['2026-09-15', 'GUSTO PAYROLL TAXES', -210433, 2],
    ['2026-09-15', 'SQUARE INC DEPOSIT SQ260915', 101190, 2],
    ['2026-09-16', 'SQUARE INC DEPOSIT SQ260916', 114725, 2],
    ['2026-09-16', 'RIDGELINE ROASTERS WHOLESALE', -148800, 2],
    ['2026-09-17', 'SQUARE INC DEPOSIT SQ260917', 123380, 2],
    ['2026-09-18', 'SQUARE INC DEPOSIT SQ260918', 176445, 2],
    ['2026-09-18', 'CHECK 1044', -32500, 2],
    ['2026-09-21', 'SQUARE INC DEPOSIT SQ260921', 275630, 3],
    ['2026-09-21', 'STATE COMP INS FUND', -41266, 3],
    ['2026-09-22', 'SQUARE INC DEPOSIT SQ260922', 99815, 3],
    ['2026-09-22', 'ODEKO DAIRY SUPPLY', -59820, 3],
    ['2026-09-23', 'SQUARE INC DEPOSIT SQ260923', 108765, 3],
    ['2026-09-24', 'SQUARE INC DEPOSIT SQ260924', 120340, 3],
    ['2026-09-24', 'SYSCO FOOD SERVICES ACH', -206739, 3],
    ['2026-09-25', 'SQUARE INC DEPOSIT SQ260925', 169875, 3],
    ['2026-09-28', 'SQUARE INC DEPOSIT SQ260928', 258190, 3],
    ['2026-09-29', 'SQUARE INC DEPOSIT SQ260929', 104420, 3],
    ['2026-09-29', 'BUSINESS CARD PAYMENT 8823', -218450, 3],
    ['2026-09-30', 'SQUARE INC DEPOSIT SQ260930', 111960, 3],
    ['2026-09-30', 'MONTHLY SERVICE FEE', -1500, 3],
    ['2026-09-30', 'INTEREST PAYMENT', 142, 3],
  ];
  var CHECKING_OPENING = 1840217;
  var MISREAD = { index: 18, read: -1240 }; // Sysco, Sep 14: 1,240.00 read as 12.40

  var CARD = [
    ['2026-08-27', 'WAREHOUSE CLUB #0412', -31648, 1],
    ['2026-08-28', 'PAYMENT - THANK YOU', 218450, 1],
    ['2026-08-29', 'CANVA PRO SUBSCRIPTION', -1499, 1],
    ['2026-08-31', 'RIDGELINE ROASTERS', -84200, 1],
    ['2026-09-01', 'GOOGLE WORKSPACE', -4200, 1],
    ['2026-09-02', 'RESTAURANT DEPOT 118', -46713, 1],
    ['2026-09-03', 'SHELL OIL 5741', -6852, 1],
    ['2026-09-05', 'WEBSTAURANTSTORE', -23987, 1],
    ['2026-09-07', 'HOME DEPOT #6620', -12744, 1],
    ['2026-09-08', 'TOAST PAYMENTS HARDWARE', -39900, 1],
    ['2026-09-10', 'WAREHOUSE CLUB #0412', -27431, 1],
    ['2026-09-11', 'WEBSTAURANTSTORE RETURN', 4499, 1],
    ['2026-09-12', 'MAILCHIMP MONTHLY', -4500, 1],
    ['2026-09-14', 'RESTAURANT DEPOT 118', -38822, 2],
    ['2026-09-15', 'ADOBE CREATIVE CLOUD', -2999, 2],
    ['2026-09-16', 'SHELL OIL 5741', -7130, 2],
    ['2026-09-18', 'UPS STORE 4471', -2214, 2],
    ['2026-09-19', 'RIDGELINE ROASTERS', -91450, 2],
    ['2026-09-21', 'YELP ADS', -15000, 2],
    ['2026-09-22', 'WAREHOUSE CLUB #0412', -29317, 2],
    ['2026-09-23', 'INTUIT QUICKBOOKS', -9000, 2],
    ['2026-09-24', 'SHELL OIL 5741', -6418, 2],
    ['2026-09-25', 'RESTAURANT DEPOT 118', -41296, 2],
    ['2026-09-26', 'CITY PARKING METERS', -650, 2],
  ];
  var CARD_OPENING = 218450;

  function build(kind, fixed) {
    var isCard = kind === 'card';
    var list = isCard ? CARD : CHECKING;
    var dir = isCard ? -1 : 1;
    var bal = isCard ? CARD_OPENING : CHECKING_OPENING;
    var rows = [], moneyIn = 0, moneyOut = 0;
    list.forEach(function (x, i) {
      var amount = x[2];
      bal += dir * amount;
      if (amount > 0) moneyIn += amount; else moneyOut -= amount;
      var lastOfDay = !list[i + 1] || list[i + 1][0] !== x[0];
      var shown = !isCard && !fixed && i === MISREAD.index ? MISREAD.read : amount;
      rows.push({ id: 'r' + (i + 1), date: x[0], desc: x[1], amount: shown, balance: !isCard && lastOfDay ? bal : null, page: x[3] });
    });
    return C.cleanStatement({
      id: isCard ? 'example-card' : 'example-checking',
      name: isCard ? 'Example card statement' : 'Example checking statement',
      src: 'example',
      bank: isCard ? 'Example Card Services' : 'Example Community Bank',
      type: isCard ? 'credit-card' : 'checking',
      last4: isCard ? '8823' : '4417',
      currency: 'USD',
      start: isCard ? '2026-08-27' : '2026-09-01',
      end: isCard ? '2026-09-26' : '2026-09-30',
      opening: isCard ? CARD_OPENING : CHECKING_OPENING,
      closing: bal,
      totals: { in: moneyIn, out: moneyOut },
      rows: rows,
      notes: [],
    });
  }

  /** The two examples, as the page opens them. */
  function statements() { return [build('checking'), build('card')]; }
  function statement(kind, fixed) { return build(kind === 'card' ? 'card' : 'checking', fixed); }

  /** "1,240.00" / "-1,240.00" as a statement prints it. */
  function printed(c) { return (c < 0 ? '-' : '') + C.fmtAbs(c); }

  /**
   * The same statement as a model's record_statement answer would give it:
   * strings as printed, grouped by page. `fixed` reads the misread row right.
   */
  function modelOutput(kind, fixed) {
    var st = build(kind === 'card' ? 'card' : 'checking', fixed);
    var pages = {};
    st.rows.forEach(function (r) {
      (pages[r.page] = pages[r.page] || []).push({ date: r.date, description: r.desc, amount: printed(r.amount), balance: r.balance === null ? null : printed(r.balance) });
    });
    return {
      readable: true,
      bank: st.bank,
      accountType: st.type,
      accountLast4: st.last4,
      currency: st.currency,
      periodStart: st.start,
      periodEnd: st.end,
      openingBalance: printed(st.opening),
      closingBalance: printed(st.closing),
      totals: { moneyIn: C.fmtAbs(st.totals.in), moneyOut: C.fmtAbs(st.totals.out) },
      pages: Object.keys(pages).map(function (p) { return { page: Number(p), transactions: pages[p], pageTotals: null }; }),
      note: '',
    };
  }

  return { statements: statements, statement: statement, modelOutput: modelOutput, MISREAD: MISREAD, CHECKING: CHECKING, CARD: CARD };
}));
