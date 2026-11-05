/* Feedfix - the demo: three broken statement files from
 * three MADE-UP banks. "Bank of Riverton", "Lakeport Credit Union" and
 * "Harbour Mutual" do not exist, and neither does any payee, account or amount here
 * (Lantern Hill Hardware, Cobble & Fern Café, Willowmere Clinic...).
 *
 * Each file is broken the way real downloads are:
 *   - Riverton: a byte-order mark, semicolons, three lines above the header,
 *     1.234,56 amounts and a closing-balance row (and a running balance
 *     that ties out, so the balance check has something to prove).
 *   - Lakeport: every date 12 or under (day/month or month/day?),
 *     accounting-style (84.12) negatives, quoted 2,150.00 amounts, a blank
 *     row, "Page 1 of 2" and the header again half way down.
 *   - Harbour Mutual: an OFX 1.0.2 file with no blank line after its SGML
 *     header and FITIDs made from the date and the amount - so two coffees
 *     on one day share an id and an importer skips the second.
 *
 * Texts only; the page and the worker turn them into bytes (with the
 * byte-order mark, or as Windows-1252) through FeedfixCore.encode. No clock,
 * no dice, no network, no storage.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FeedfixDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function groups(n, sep) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep); }
  function pad(n) { return ('0' + n).slice(-2); }
  /** 1.250,00 - the way a continental bank writes it. */
  function comma(cents) { var c = Math.abs(cents); return (cents < 0 ? '-' : '') + groups(Math.floor(c / 100), '.') + ',' + pad(c % 100); }
  /** 2,150.00 / (84.12) - the way an accounting export writes it. */
  function paren(cents) { var c = Math.abs(cents), s = groups(Math.floor(c / 100), ',') + '.' + pad(c % 100); return cents < 0 ? '(' + s + ')' : s; }
  function plain(cents) { var c = Math.abs(cents); return (cents < 0 ? '-' : '') + Math.floor(c / 100) + '.' + pad(c % 100); }
  function q(s) { return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  // Bank of Riverton - Everyday Checking, October 2026, in euros.
  var RIVERTON = [
    [1, 'Maple Row Studio', 'Invoice 118 paid', 125000],
    [2, 'Lantern Hill Hardware', 'Card purchase', -8412],
    [3, 'Cobble & Fern Café', 'Card purchase', -1240],
    [5, 'Harrow Street Lettings', 'Office rent October', -95000],
    [7, 'Kestrel Telecom', 'Direct debit', -5999],
    [9, 'Juniper Desk Supplies', 'Card purchase', -14360],
    [12, 'Willowmere Clinic', 'Invoice 121 paid', 240000],
    [13, 'Northgate Fuel', 'Card purchase', -6135],
    [14, 'Saltmarsh Courier', 'Card purchase', -1890],
    [16, 'Brightwick Insurance', 'Direct debit', -21250],
    [19, 'Orchard Lane Bakery', 'Card purchase', -2780],
    [20, 'Fenwick & Daughters Printing', 'Business cards', -9600],
    [22, 'Maple Row Studio', 'Invoice 124 paid', 78000],
    [23, 'Riverton Water Co-op', 'Direct debit', -4415],
    [26, 'Lantern Hill Hardware', 'Card purchase', -3999],
    [28, 'Kittiwake Software', 'Subscription', -2900],
    [29, 'Cobble & Fern Café', 'Card purchase', -960],
    [30, 'Bank of Riverton', 'Account fee', -750],
    [31, 'Bank of Riverton', 'Interest', 85],
  ];
  function riverton() {
    var bal = 216025;
    var L = ['Bank of Riverton - Account statement', 'Account: Everyday Checking, ending 4417', 'Statement period: 01.10.2026 - 31.10.2026', 'Booking date;Value date;Payee;Description;Amount;Balance'];
    RIVERTON.forEach(function (r) {
      bal += r[3];
      var d = pad(r[0]) + '.10.2026', v = pad(Math.min(31, r[0] + (r[3] < 0 && r[2] === 'Card purchase' ? 1 : 0))) + '.10.2026';
      L.push([d, v, r[1], r[2], comma(r[3]), comma(bal)].join(';'));
    });
    L.push('Closing balance;;;;;' + comma(bal));
    return L.join('\r\n') + '\r\n';
  }

  // Lakeport Credit Union - share draft, February and March 2026, in
  // dollars. Every date is month/day with a day of 12 or under.
  var LAKEPORT = [
    ['02/01/2026', 'PAYROLL WILLOWMERE CLINIC', '', 215000],
    ['02/02/2026', 'LANTERN HILL HARDWARE', '', -8412],
    ['02/03/2026', 'CHECK 1041', '1041', -45000],
    ['02/05/2026', 'KESTREL TELECOM AUTOPAY', '', -5999],
    ['02/06/2026', 'ORCHARD LANE BAKERY', '', -1425],
    ['02/09/2026', 'NORTHGATE FUEL 212', '', -4870],
    ['02/10/2026', 'SHARE DIVIDEND', '', 312],
    ['02/11/2026', 'HARROW STREET LETTINGS', '', -110000],
    null,
    ['02/12/2026', 'BRIGHTWICK INSURANCE', '', -21250],
    ['03/02/2026', 'PAYROLL WILLOWMERE CLINIC', '', 215000],
    ['03/03/2026', 'JUNIPER DESK SUPPLIES', '', -6340],
    ['03/04/2026', 'CHECK 1042', '1042', -27500],
    ['03/05/2026', 'COBBLE & FERN CAFE', '', -875],
    ['03/09/2026', 'RIVERTON WATER CO-OP', '', -4118],
    ['03/10/2026', 'SALTMARSH COURIER', '', -2200],
    ['03/11/2026', 'TRANSFER FROM SAVINGS', '', 50000],
    ['03/12/2026', 'SHARE DIVIDEND', '', 297],
  ];
  function lakeport() {
    var head = 'Date,Description,Check No,Amount';
    var L = [head];
    LAKEPORT.forEach(function (r) {
      if (!r) { L.push(',,,'); L.push('Page 1 of 2'); L.push(head); return; }
      L.push([r[0], q(r[1]), r[2], q(paren(r[3]))].join(','));
    });
    L.push('Page 2 of 2');
    return L.join('\r\n') + '\r\n';
  }

  // Harbour Mutual - current account, October 2026, in pounds. The bank
  // builds each FITID from the date and the amount, so two identical card
  // payments on one day get one id.
  var HARBOUR = [
    ['20261001', 'CREDIT', 150000, 'Maple Row Studio', 'INV 131'],
    ['20261002', 'DEBIT', -8412, 'Lantern Hill Hardware', 'Card 5521'],
    ['20261005', 'DIRECTDEBIT', -5999, 'Kestrel Telecom', 'Broadband'],
    ['20261007', 'POS', -340, 'Cobble & Fern Café', 'Card 5521'],
    ['20261007', 'POS', -340, 'Cobble & Fern Café', 'Card 5521'],
    ['20261009', 'DEBIT', -14360, 'Juniper Desk Supplies', 'Card 5521'],
    ['20261012', 'CREDIT', 240000, 'Willowmere Clinic', 'INV 133'],
    ['20261014', 'DIRECTDEBIT', -21250, 'Brightwick Mutual Insurance Society Ltd', 'Policy premium'],
    ['20261015', 'POS', -1250, 'Saltmarsh Courier', 'Card 5521'],
    ['20261015', 'POS', -1250, 'Saltmarsh Courier', 'Card 5521'],
    ['20261019', 'POS', -2780, 'Orchard Lane Bakery', 'Card 5521'],
    ['20261021', 'DEBIT', -95000, 'Harrow Street Lettings', 'Rent'],
    ['20261023', 'DIRECTDEBIT', -4415, 'Riverton Water Co-op', 'Water'],
    ['20261027', 'POS', -6135, 'Northgate Fuel', 'Card 5521'],
    ['20261030', 'FEE', -750, 'Harbour Mutual', 'Monthly account fee'],
    ['20261031', 'INT', 85, 'Harbour Mutual', 'Interest'],
  ];
  function amp(s) { return s.replace(/&/g, '&amp;'); }
  function harbour() {
    var bal = 184217;
    HARBOUR.forEach(function (r) { bal += r[2]; });
    var L = ['OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE',
      '<OFX>', '<SIGNONMSGSRSV1>', '<SONRS>', '<STATUS>', '<CODE>0', '<SEVERITY>INFO', '</STATUS>', '<DTSERVER>20261101083000', '<LANGUAGE>ENG', '<FI>', '<ORG>Harbour Mutual', '<FID>9001', '</FI>', '</SONRS>', '</SIGNONMSGSRSV1>',
      '<BANKMSGSRSV1>', '<STMTTRNRS>', '<TRNUID>1', '<STATUS>', '<CODE>0', '<SEVERITY>INFO', '</STATUS>', '<STMTRS>', '<CURDEF>GBP',
      '<BANKACCTFROM>', '<BANKID>900001', '<ACCTID>00008421', '<ACCTTYPE>CHECKING', '</BANKACCTFROM>',
      '<BANKTRANLIST>', '<DTSTART>20261001', '<DTEND>20261031'];
    HARBOUR.forEach(function (r) {
      var fitid = r[0] + (r[2] < 0 ? 'D' : 'C') + ('000000' + Math.abs(r[2])).slice(-7);
      L.push('<STMTTRN>', '<TRNTYPE>' + r[1], '<DTPOSTED>' + r[0], '<TRNAMT>' + plain(r[2]), '<FITID>' + fitid, '<NAME>' + amp(r[3]), '<MEMO>' + amp(r[4]), '</STMTTRN>');
    });
    L.push('</BANKTRANLIST>', '<LEDGERBAL>', '<BALAMT>' + plain(bal), '<DTASOF>20261031', '</LEDGERBAL>', '</STMTRS>', '</STMTTRNRS>', '</BANKMSGSRSV1>', '</OFX>');
    return L.join('\r\n') + '\r\n';
  }

  function files() {
    return [
      { id: 'riverton', bank: 'Bank of Riverton', label: 'Riverton checking', name: 'riverton-checking-oct-2026.csv', encoding: 'utf-8', bom: true, text: riverton(), currency: 'EUR', blurb: 'A CSV with a byte-order mark, semicolons, the bank’s name above the header, 1.234,56 amounts and a closing-balance row.', hint: 'delimiter' },
      { id: 'lakeport', bank: 'Lakeport Credit Union', label: 'Lakeport share draft', name: 'lakeport-cu-export.csv', encoding: 'utf-8', bom: false, text: lakeport(), currency: 'USD', blurb: 'Every date could be day/month or month/day, negatives in (parentheses), and the header again half way down.', hint: 'pages' },
      { id: 'harbour', bank: 'Harbour Mutual', label: 'Harbour current account', name: 'harbour-mutual-oct-2026.ofx', encoding: 'windows-1252', bom: false, text: harbour(), currency: 'GBP', blurb: 'An OFX file whose header trips strict readers, with two pairs of transactions sharing a FITID - the second of each would be skipped.', hint: 'fitid-dup' },
    ];
  }

  return { files: files, BANKS: ['Bank of Riverton', 'Lakeport Credit Union', 'Harbour Mutual'] };
}));
