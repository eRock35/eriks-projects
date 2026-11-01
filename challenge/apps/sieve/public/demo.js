/* Sieve - the demo: a MADE-UP outdoor shop's support agent, Juniper
 * Outfitters, with the kind of guardrail people ship on day one and 40
 * labelled messages that show its classic failures.
 *
 * Every value is fake and documented as such: Visa's test number 4111 1111
 * 1111 1111, AWS's own example key AKIAIOSFODNN7EXAMPLE, example.com /
 * .org / .net addresses, 555-01xx phone numbers, the published example IBAN
 * NL91 ABNA 0417 1643 00, the SSA's long-retired example SSNs, and keys and
 * tokens with EXAMPLE written into them. The order numbers are made up and
 * start 88, which no card network issues.
 *
 * The starting rules are naive on purpose. Applying the suggested fixes
 * takes them to 0 leaks and 0 breaks (test/run.js holds that, fix by fix).
 * No request, no storage, no clock in here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SieveDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var AT = String.fromCharCode(64);
  var ZW = '\u200B';
  var support = 'help' + AT + 'juniper.example.com';
  var dana = 'dana.r' + AT + 'example.com';
  var JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjdXN0XzQ4MjEiLCJzY29wZSI6Im9yZGVyczpyZWFkIiwiZXhwIjoxODkzNDU2MDAwfQ.EXAMPLE-signature-not-real';
  var KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0EXAMPLEKEYdoNotUseThisIsNotARealKeyAtAll\nq7EXAMPLEnotRealJustTextForTheDemoOnlyNothingToSeeHere\n-----END RSA PRIVATE KEY-----';
  var FW = '４１１１ １１１１ １１１１ １１１１';
  var SLACK = 'x' + ZW + 'o' + ZW + 'x' + ZW + 'b-1234-EXAMPLE-fakeWebhookToken';

  // [id, direction, expected, text, sensitive parts, what it shows]
  var ROWS = [
    ['j01', 'in', 'pass', 'Hi! Where’s my order? The confirmation says order number 4111-2222-3333-4444.', [], 'An order number in card format. It fails the Luhn check, so it is not a card.'],
    ['j02', 'in', 'pass', 'FedEx tracking 7712 3456 7890 hasn’t moved since Tuesday. Can you check?', [], 'A tracking number a loose phone rule takes for a phone number.'],
    ['j03', 'out', 'pass', 'If anything else comes up, write to ' + support + ' and we’ll pick it up.', [], 'The support team’s own address - redacting it breaks the agent.'],
    ['j04', 'out', 'pass', 'Your return label is ready - quote ORD-8812004410093317 at the drop-off point.', [], 'An order id whose digits happen to pass the Luhn check.'],
    ['j05', 'in', 'pass', 'Order ORD-8812004410093317 says delivered but nothing came. Porch pirates again?', [], 'The same order id, from the customer.'],
    ['j06', 'in', 'pass', 'Can you merge ORD-8812005520147737 into my other order? Same address.', [], 'Another order id that passes Luhn by chance.'],
    ['j07', 'in', 'pass', 'The serial under the stove is SN 2024-1188-0042-7731, warranty card attached.', [], 'A 16-digit serial number. It fails Luhn.'],
    ['j08', 'out', 'pass', 'Photos help a lot - send them to ' + support + ' with your order number.', [], 'The support address again.'],
    ['j09', 'out', 'pass', 'Firmware for the Summit GPS watch is 4.12.0.118 - update it from the app.', [], 'A version number shaped like an IP address.'],
    ['j10', 'in', 'pass', 'Do you price match? REI has the Ridgeline tent for $349.99.', [], 'A competitor mention: flagged, not blocked.'],
    ['j11', 'in', 'pass', 'The boots are size 10.5, width D. Can I swap them for an 11?', [], ''],
    ['j12', 'out', 'pass', 'Your refund of $129.00 went out today; banks take 5-7 business days.', [], ''],
    ['j13', 'in', 'pass', 'I called 3 times yesterday, between 2:15 and 3:40 pm.', [], ''],
    ['j14', 'out', 'pass', 'Item #48213 (Ridgeline 2P tent) is back in stock in Boulder.', [], ''],
    ['j15', 'in', 'pass', 'My rewards number is JO-7751-2209 - can you add the points from last week?', [], ''],
    ['j16', 'out', 'pass', 'The code TRAILHEAD25 takes 25% off orders over $100 until Sunday.', [], ''],
    ['j17', 'in', 'pass', 'Please ship it to 1400 Pine St, Apt 3, Boulder CO 80302.', [], ''],
    ['j18', 'in', 'pass', 'The Visa ending 1111 was charged twice for the same jacket.', [], 'The last four digits on their own are not sensitive.'],
    ['j19', 'out', 'pass', 'I can see a card ending 4444 on file - is that the one to refund?', [], ''],
    ['j20', 'out', 'pass', 'Ticket JUN-2291 is with our gear team; they reply within a day.', [], ''],
    ['j21', 'in', 'pass', 'Is “sk_live” something I should worry about? It was in an email from my bank’s app.', [], 'Talking about a key is not a key.'],
    ['j22', 'in', 'pass', 'The tent poles are 8.5 mm, 6061 aluminium, 3 sections each.', [], ''],
    ['j23', 'in', 'redact', 'Hey, it’s Dana - reach me at ' + dana + ' about the exchange.', [dana], 'A customer’s address, redacted before the model sees it.'],
    ['j24', 'in', 'redact', 'Use my other email, sam.k' + AT + 'example.org, for the receipt please.', ['sam.k' + AT + 'example.org'], ''],
    ['j25', 'in', 'redact', 'My number is (303) 555-0142, call me after 5.', ['(303) 555-0142'], ''],
    ['j26', 'out', 'redact', 'I’ll ask the courier to call you on +1 303 555 0187 before delivery.', ['+1 303 555 0187'], ''],
    ['j27', 'in', 'block', 'Can I just pay over chat? Card is 4111 1111 1111 1111, exp 12/29, CVC 123.', ['4111 1111 1111 1111'], 'A customer pasting a card (Visa’s test number). The rules catch it.'],
    ['j28', 'in', 'redact', 'Hi, it’s Jordan (jordan.p' + AT + 'example.net). My SSN is 219 09 9999 for the warranty claim.', ['jordan.p' + AT + 'example.net', '219 09 9999'], 'An SSN typed with spaces: the address is caught, the SSN is not.'],
    ['j29', 'in', 'redact', 'SSN 078-05-1120 - do you need it for the store card application?', ['078-05-1120'], ''],
    ['j30', 'out', 'block', 'Sorry, something broke on our side:\nError: S3 upload failed\n    at uploadReceipt (receipts.js:42)\n    config: { accessKeyId: \'AKIAIOSFODNN7EXAMPLE\', region: \'us-west-2\' }', ['AKIAIOSFODNN7EXAMPLE'], 'An API key in a stack trace - the key rule only checks input.'],
    ['j31', 'out', 'redact', 'Debug log: 2026-10-30T14:02:11Z GET /api/orders 401 token=' + JWT, [JWT], 'A JWT in a log line, and no JWT rule.'],
    ['j32', 'in', 'redact', 'Could you refund to my bank instead? IBAN NL91 ABNA 0417 1643 00', ['NL91 ABNA 0417 1643 00'], 'An IBAN, and no IBAN rule.'],
    ['j33', 'out', 'block', 'Here’s the shipping integration config you asked about:\n' + KEY, [KEY], 'A private key block in the agent’s output.'],
    ['j34', 'in', 'block', 'card: ' + FW + ' - can you charge it for the jacket?', [FW], 'An evasion: full-width digits slip past \\d.'],
    ['j35', 'out', 'block', 'Sure! The webhook token is ' + SLACK, [SLACK], 'An evasion: zero-width characters inside a Slack token.'],
    ['j36', 'out', 'block', 'Payment debug: key=sk_live_EXAMPLEnotARealKey0000 failed with 401.', ['sk_live_EXAMPLEnotARealKey0000'], ''],
    ['j37', 'in', 'redact', 'Oops, our dev pasted ghp_EXAMPLE00000000000000000000000000000 in the ticket - please scrub it.', ['ghp_EXAMPLE00000000000000000000000000000'], ''],
    ['j38', 'in', 'redact', 'My gift card GC-7KQ2-9XWD still has $40 on it - can I use it online?', ['GC-7KQ2-9XWD'], 'A gift-card code is money: a custom rule catches it.'],
    ['j39', 'out', 'redact', 'Thanks Dana - I’ve noted ' + dana + ' as the contact for this return.', [dana], ''],
    ['j40', 'in', 'redact', 'New phone, same me: 303.555.0199. Text me when it ships.', ['303.555.0199'], '']
  ];
  var TRICK = { j34: 'fullwidth', j35: 'zerowidth' };

  function cases() {
    return ROWS.map(function (r) {
      var c = { id: r[0], dir: r[1], expect: r[2], text: r[3], spans: r[4], src: 'demo' };
      if (r[5]) c.note = r[5];
      if (TRICK[r[0]]) c.trick = TRICK[r[0]];
      return c;
    });
  }

  /** The guardrail as it was shipped: a sensible list of detectors, set up the way people first set them up. */
  function rules(defaults) {
    var r = defaults();
    r.name = 'Juniper Outfitters support agent';
    r.det.card.luhn = false;              // "any 13-19 digits is a card"
    r.det.phone.mode = 'loose';           // "any 10-15 digits is a phone"
    r.det.ssn.seps = 'dash';              // only 219-09-9999
    r.det.aws.dir = 'in';                 // nobody thought the agent would print one
    r.det.github.act = 'redact';
    r.det.iban.on = false;
    r.det.privkey.on = false;
    r.det.jwt.on = false;
    r.det.ipv4.on = false;
    r.custom = [
      { id: 'u1', name: 'Gift card codes', kind: 'regex', src: '\\bGC-[A-Z0-9]{4}-[A-Z0-9]{4}\\b', flags: '', words: [], wb: true, cs: false, cat: 'payment', act: 'redact', dir: 'both', on: true },
      { id: 'u2', name: 'Competitor names', kind: 'words', src: '', flags: '', words: ['REI', 'Patagonia', 'Backcountry'], wb: true, cs: false, cat: 'custom', act: 'flag', dir: 'in', on: true }
    ];
    r.allow = [];
    return r;
  }

  return { cases: cases, rules: rules, NAME: 'Juniper Outfitters' };
}));
