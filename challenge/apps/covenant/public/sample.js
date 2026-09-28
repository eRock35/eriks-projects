/* Covenant - the example loan. Everything here is INVENTED: the bakery, the
 * bank, the section numbers and the agreement's words were written for this
 * demo, and the page labels it as an example wherever it shows.
 *
 * UMD, like covenant-core.js: the page draws it with no request and no
 * account, the server's fake model answers the example text with it, and the
 * tests hold that every quote below really is in TEXT (so the example shows
 * what a verified reading looks like) and that the numbers tell the story
 * the page says they do: DSCR tight, the current ratio comfortable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CovenantSample = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NAME = 'Example: Riverbend Bakery LLC - $350,000 SBA 7(a) term loan from Example Community Bank';

  var TEXT = [
    'EXAMPLE ONLY - INVENTED FOR THE COVENANT DEMO. THIS IS NOT A REAL AGREEMENT AND NOT A REAL BUSINESS OR BANK.',
    '',
    'LOAN AGREEMENT',
    '',
    'This Loan Agreement is dated October 1, 2024, between Riverbend Bakery LLC (the "Borrower") and Example Community Bank (the "Lender"). The Lender has agreed to make a term loan to the Borrower in the principal amount of $350,000 under the U.S. Small Business Administration 7(a) loan program (the "Term Loan"), maturing October 1, 2034, and to make available a revolving line of credit of up to $75,000 (the "Line").',
    '',
    'ARTICLE 1. DEFINITIONS',
    '',
    '1.1 "EBITDA" means, for any period, the Borrower\'s net income for that period plus, to the extent deducted in computing net income, interest expense, income tax expense, depreciation and amortization, minus any distributions paid to members during that period.',
    '',
    '1.2 "Debt Service" means, for any period, all scheduled payments of principal and interest on all Indebtedness of the Borrower paid or payable during that period, including the Term Loan and any capital lease obligations.',
    '',
    '1.3 "Senior Funded Debt" means all Indebtedness for borrowed money, including the Term Loan, the outstanding balance of the Line and capital lease obligations, but excluding Subordinated Debt.',
    '',
    '1.4 "Current Ratio" means current assets divided by current liabilities, each determined in accordance with generally accepted accounting principles, provided that the current portion of the Term Loan shall be included in current liabilities.',
    '',
    'ARTICLE 5. AFFIRMATIVE COVENANTS',
    '',
    'So long as any amount remains unpaid under this Agreement, the Borrower shall:',
    '',
    '5.2 Financial Reporting.',
    '(a) Annual Statements. Within 120 days after the end of each fiscal year, deliver to the Lender annual financial statements of the Borrower, reviewed by an independent certified public accountant acceptable to the Lender, together with a compliance certificate signed by an officer of the Borrower.',
    '(b) Quarterly Statements. Within 45 days after the end of each of the first three fiscal quarters of each fiscal year, deliver to the Lender internally prepared balance sheets and income statements for that quarter and for the fiscal year to date.',
    '(c) Borrowing Base Certificate. Within 20 days after the end of each calendar month in which any amount is outstanding under the Line, deliver to the Lender a borrowing base certificate in the form required by the Lender, showing eligible accounts receivable and eligible inventory as of the end of that month.',
    '',
    '5.6 Insurance. Maintain property insurance on all of its equipment, inventory and leasehold improvements in amounts and with insurers reasonably acceptable to the Lender, naming the Lender as lender loss payee, and deliver certificates of that insurance to the Lender upon request.',
    '',
    'ARTICLE 6. FINANCIAL COVENANTS',
    '',
    '6.1 The Borrower shall maintain, tested as of the end of each fiscal year on the basis of the annual financial statements delivered under Section 5.2(a) unless stated otherwise:',
    '(a) Debt Service Coverage. A ratio of EBITDA to Debt Service of not less than 1.25 to 1.00.',
    '(b) Leverage. A ratio of Senior Funded Debt to EBITDA of not more than 3.00 to 1.00.',
    '(c) Liquidity. A Current Ratio of not less than 1.20 to 1.00, tested as of the end of each fiscal quarter.',
    '',
    'ARTICLE 7. NEGATIVE COVENANTS',
    '',
    'So long as any amount remains unpaid under this Agreement, the Borrower shall not, without the prior written consent of the Lender:',
    '',
    '7.1 Additional Indebtedness. Create, incur or assume any Indebtedness other than the Term Loan and the Line, except trade payables in the ordinary course of business and other Indebtedness not exceeding $25,000 in the aggregate at any time outstanding.',
    '',
    '7.4 Change of Ownership. Permit any change in the ownership of the Borrower such that the persons who own the Borrower on the date of this Agreement cease to own at least 100% of its membership interests, or merge or consolidate with any other entity.',
    '',
    'ARTICLE 8. EVENTS OF DEFAULT',
    '',
    '8.1 A failure to comply with any covenant in Article 6 or Article 7, or a failure to deliver any report under Section 5.2 within 15 days after it is due, is an Event of Default.',
  ].join('\n');

  var LOAN = {
    lender: 'Example Community Bank',
    borrower: 'Riverbend Bakery LLC',
    amount: '$350,000 term loan + $75,000 line',
    type: 'SBA 7(a) term loan and line of credit',
    maturity: 'October 1, 2034',
  };

  // What a reading of TEXT returns, in the shape the model's tool gives it.
  var RAW = [
    {
      kind: 'financial', title: 'Debt service coverage of at least 1.25x', section: '6.1(a)', metric: 'dscr',
      threshold: { op: '>=', value: 1.25, unit: 'x' }, testedWhen: 'annually', dueRule: null,
      plain: 'Each year, your earnings (EBITDA) must be at least 1.25 times everything you pay on your loans that year. It is checked on the annual statements.',
      explainToCustomer: 'The bank wants to see that the business earns comfortably more than its loan payments. Each year we compare your EBITDA with the total principal and interest you paid on all your loans, and it needs to be at least $1.25 for every $1.00 of payments. If you think it might dip below that, call us before year end so we can talk it through.',
      definitionNotes: 'EBITDA is net income plus interest, taxes, depreciation and amortization, MINUS distributions paid to members. Debt Service counts principal and interest on all debt, including capital leases (Sections 1.1 and 1.2).',
      quote: 'A ratio of EBITDA to Debt Service of not less than 1.25 to 1.00.', confidence: 'high',
    },
    {
      kind: 'financial', title: 'Leverage of no more than 3.0x', section: '6.1(b)', metric: 'leverage',
      threshold: { op: '<=', value: 3.0, unit: 'x' }, testedWhen: 'annually', dueRule: null,
      plain: 'Your total borrowed money (the term loan, the line balance and capital leases) can be at most three times one year of EBITDA.',
      explainToCustomer: 'This one caps how much the business owes compared with what it earns in a year. Add up the term loan, whatever is drawn on the line and any equipment leases - that total can’t be more than three times your yearly EBITDA. Paying down the line before year end is the usual way to give yourself room.',
      definitionNotes: 'Senior Funded Debt includes the Term Loan, the Line balance and capital lease obligations, but not subordinated debt (Section 1.3). EBITDA is after member distributions (Section 1.1).',
      quote: 'A ratio of Senior Funded Debt to EBITDA of not more than 3.00 to 1.00.', confidence: 'high',
    },
    {
      kind: 'financial', title: 'Current ratio of at least 1.2x', section: '6.1(c)', metric: 'current_ratio',
      threshold: { op: '>=', value: 1.2, unit: 'x' }, testedWhen: 'quarterly', dueRule: null,
      plain: 'At the end of every quarter, what you own that turns into cash within a year must be at least 1.2 times what you owe within a year.',
      explainToCustomer: 'Every quarter we look at the balance sheet: short-term assets like cash, receivables and inventory need to be at least 1.2 times the bills and payments due in the next twelve months. The part of your loan due this year counts as a bill here, which surprises a lot of owners.',
      definitionNotes: 'Measured under GAAP, and the current portion of the Term Loan counts as a current liability (Section 1.4).',
      quote: 'A Current Ratio of not less than 1.20 to 1.00, tested as of the end of each fiscal quarter.', confidence: 'high',
    },
    {
      kind: 'reporting', title: 'Annual CPA-reviewed financial statements', section: '5.2(a)', metric: null, threshold: null,
      testedWhen: 'annually', dueRule: { daysAfter: 120, of: 'fiscal_year_end' },
      plain: 'Send the bank a year of financial statements reviewed by an outside CPA, plus a signed compliance certificate, within 120 days after your fiscal year ends.',
      explainToCustomer: 'Once a year, within 120 days of your year end, we need statements your CPA has reviewed - not just compiled - along with a short certificate an owner signs saying you met the loan’s terms. Booking the CPA early is the easiest way to hit this one.',
      definitionNotes: 'A review, not a compilation, by a CPA the Lender accepts; the compliance certificate goes with it. A report more than 15 days late is an Event of Default (Section 8.1).',
      quote: 'Within 120 days after the end of each fiscal year, deliver to the Lender annual financial statements of the Borrower, reviewed by an independent certified public accountant acceptable to the Lender', confidence: 'high',
    },
    {
      kind: 'reporting', title: 'Quarterly internal financial statements', section: '5.2(b)', metric: null, threshold: null,
      testedWhen: 'quarterly', dueRule: { daysAfter: 45, of: 'quarter_end', exceptFiscalYearEnd: true },
      plain: 'For the first three quarters of each year, send your own balance sheet and income statement within 45 days after the quarter ends.',
      explainToCustomer: 'Three times a year - after the first, second and third quarters - send us the balance sheet and profit and loss your bookkeeper already produces, within 45 days. They don’t need a CPA. The fourth quarter is covered by the annual statements.',
      definitionNotes: 'Internally prepared is fine. Covers the quarter and the year to date.',
      quote: 'Within 45 days after the end of each of the first three fiscal quarters of each fiscal year, deliver to the Lender internally prepared balance sheets and income statements', confidence: 'high',
    },
    {
      kind: 'reporting', title: 'Monthly borrowing base certificate (for the line)', section: '5.2(c)', metric: null, threshold: null,
      testedWhen: 'monthly', dueRule: { daysAfter: 20, of: 'month_end' },
      plain: 'In any month the line of credit has a balance, send a borrowing base certificate - your eligible receivables and inventory - within 20 days after the month ends.',
      explainToCustomer: 'When you have a balance on the line, the amount you can borrow depends on your receivables and inventory, so once a month we need a short form showing those as of month end. It is due by the 20th. If the line is paid to zero, you can skip it that month.',
      definitionNotes: 'Only for months with a balance on the Line; on the Lender’s own form.',
      quote: 'Within 20 days after the end of each calendar month in which any amount is outstanding under the Line, deliver to the Lender a borrowing base certificate', confidence: 'high',
    },
    {
      kind: 'negative', title: 'No new debt over $25,000 without consent', section: '7.1', metric: null,
      threshold: { op: '<=', value: 25000, unit: '$' }, testedWhen: 'ongoing', dueRule: null,
      plain: 'Apart from this loan, the line and normal supplier bills, you can’t owe more than $25,000 in total to anyone else unless the bank agrees in writing first.',
      explainToCustomer: 'Before you finance a new oven, sign an equipment lease or take a card-sales advance, check with us. Anything beyond this loan and your normal supplier bills can’t add up to more than $25,000 without our written OK - and asking first is almost always a quick yes.',
      definitionNotes: 'The $25,000 is in total, at any one time. Trade payables in the ordinary course do not count.',
      quote: 'other Indebtedness not exceeding $25,000 in the aggregate at any time outstanding', confidence: 'high',
    },
    {
      kind: 'negative', title: 'No change of ownership', section: '7.4', metric: null, threshold: null, testedWhen: 'ongoing', dueRule: null,
      plain: 'The people who own the business today must keep owning all of it, and it can’t merge with another company, unless the bank agrees in writing.',
      explainToCustomer: 'If you’re thinking of bringing in a partner, selling a share or merging, talk to us first - the loan assumes today’s owners keep 100% of the business. We can often approve it; we just need to be asked before it happens.',
      definitionNotes: 'Any change below 100% of today’s owners counts, as does a merger or consolidation.',
      quote: 'Permit any change in the ownership of the Borrower', confidence: 'high',
    },
    {
      kind: 'insurance', title: 'Property insurance naming the bank', section: '5.6', metric: null, threshold: null, testedWhen: 'ongoing', dueRule: null,
      plain: 'Keep your equipment, inventory and leasehold improvements insured, with the bank named as lender loss payee, and send proof when asked.',
      explainToCustomer: 'Your property policy needs to list us as “lender loss payee”, so if there is a fire the claim helps pay off what’s owed. Ask your insurance agent to add us and send a certificate - and keep it in place at every renewal.',
      definitionNotes: 'Amounts and insurers reasonably acceptable to the Lender.',
      quote: 'naming the Lender as lender loss payee', confidence: 'high',
    },
  ];

  // The health-check numbers, per period (dollars as typed). DSCR slides
  // from 1.64x to 1.31x - still passing, now tight - while the current ratio
  // stays comfortably clear of 1.2x. That is the story the example tells.
  var PERIODS = {
    '2024 FY': { ebitda: '158,200', debtService: '96,400', totalDebt: '342,000', currentAssets: '170,000', currentLiabilities: '95,000' },
    '2025 FY': { ebitda: '141,000', debtService: '96,400', totalDebt: '331,000', currentAssets: '176,000', currentLiabilities: '93,000' },
    '2026 Q2': { ebitda: '131,900', debtService: '96,400', totalDebt: '322,000', currentAssets: '181,000', currentLiabilities: '92,000' },
    '2026 Q3': { ebitda: '126,300', debtService: '96,400', totalDebt: '318,000', currentAssets: '184,000', currentLiabilities: '92,000' },
  };
  var PERIOD = '2026 Q3';

  return { NAME: NAME, TEXT: TEXT, LOAN: LOAN, RAW: RAW, PERIODS: PERIODS, PERIOD: PERIOD, FYE: 12 };
}));
