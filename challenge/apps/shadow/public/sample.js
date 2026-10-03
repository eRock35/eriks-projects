/* Shadow - the example: Harbor County Library, a made-up public library
 * system with a year of one made-up purchasing card and a made-up Google
 * Workspace app-access export, run through the same rules as anyone's own
 * files (ShadowCore), then the decisions its IT lead has already written
 * down. Dated relative to today, so the trial always converts in 3 days.
 *
 * The well-known services here are only ever shown approved or under review
 * at prices that are plausible, never real quotes. Every tool with a problem
 * - the note-taker reading mail, the homework helper with no DPA, the second
 * e-signature tool, the trial - is an invented name. No real business is
 * described.
 *
 * UMD: window.ShadowSample in the page, require() in the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./shadow-core'));
  else root.ShadowSample = factory(root.ShadowCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var ORG = { name: 'Harbor County Library', kind: 'public', blurb: 'a made-up library system: 6 branches, 48 staff' };

  // [descriptor, dollars, how often, offset]: monthly bills on day-of-year
  // offset `o` back from today; 'annual' is one charge `o` days ago;
  // 'once' likewise.
  var BILLS = [
    ['GOOGLE *GSUITE_harborcolib', 96.00, 'monthly', 4],
    ['ZOOM.US 888-799-9666 CA', 149.90, 'annual', 140],
    ['CANVA* 04412-77812 SYDNEY', 119.99, 'annual', 205],
    ['ADOBE *CREATIVE CLOUD 408-536-6000 CA', 89.99, 'monthly', 9],
    ['INTUIT *MAILCHIMP ATLANTA GA', 110.00, 'monthly', 12],
    ['DOCUSIGN INC 866-219-4318 CA', 480.00, 'annual', 318],
    ['INTUIT *QBOOKS ONLINE CA', 90.00, 'monthly', 15],
    ['GUSTO PAYROLL SAN FRANCISCO CA', 220.00, 'monthly', 2],
    ['SURVEYMONKEY SAN MATEO CA', 384.00, 'annual', 343],
    
    ['1PASSWORD AGILEBITS TORONTO ON', 39.95, 'monthly', 6],
    ['SQUARESPACE INC 646-555-0140 NY', 276.00, 'annual', 251],
    ['GODADDY.COM 480-505-8855 AZ', 119.99, 'annual', 101],
    // Invented
    ['NOTEWISE.AI SUBSCR 888-555-0101 CA', 240.00, 'monthly', 7, { trialMonthsAgo: 9 }],
    ['HOMEWORKHERO.APP AUSTIN TX', 1800.00, 'annual', 152],
    ['FORMLY.IO 415-555-0122 CA', 49.00, 'monthly', 11],
    ['INKSWIFT SIGN SOFTWARE', 100.00, 'monthly', 16],
    ['SHELFSCOUT ANALYTICS SOFTWARE', 2400.00, 'annual', 300],
    ['READSY APP SUBSCRIPTION', 59.00, 'monthly', 23],
    ['VOLUNTEERLY HQ', 35.00, 'monthly', 27],
    ['GRANTWELL SOFTWARE BOSTON MA', 900.00, 'annual', 326],
    ['PRINTDESK CLOUD SVCS', 180.00, 'monthly', 13],
    ['KIOSKO.APP', 75.00, 'monthly', 19],
    ['FLOWBRIDGE.IO SAN FRANCISCO CA', 29.99, 'monthly', 25],
    ['SIGNUPSTER.COM SOFTWARE', 8.99, 'monthly', 21],
    ['BOOKWELL.APP 470-555-0199 GA', 12.00, 'monthly', 18],
    ['QUILLMATE AI 650-555-0177 CA', 30.00, 'monthly', 24],
    ['BRIGHTDESK TECH PORTAL', 64.00, 'monthly', 29],
  ];
  // Ordinary spending a library card carries. None of it is software, and
  // the rules must say so.
  var NOISE = [
    ['STAPLES 00123 HARBOR CITY', [48.12, 112.40, 23.99, 67.05, 88.10, 41.75]],
    ['DEMCO INC 800-356-1200 WI', [412.88, 96.40, 233.10]],
    ['AMAZON.COM*2K4TT1 AMZN.COM/BILL WA', [64.99, 23.49, 118.20, 39.99, 12.99, 77.30, 45.00]],
    ['STARBUCKS STORE 08812', [18.40, 22.15, 9.80]],
    ['COMCAST BUSINESS 800-391-3000', [189.00, 189.00, 189.00, 189.00, 189.00, 189.00, 189.00, 189.00, 189.00, 189.00, 189.00, 189.00]],
    ['USPS PO 0412345 HARBOR CITY', [31.20, 18.65, 44.10]],
    ['HARBOR CATERING CO', [640.00, 380.00]],
    ['HOME DEPOT #4412', [86.12, 154.33]],
    ['HAMPTON INN STATE CONF', [289.00]],
    ['GAYLORD BROS LIBRARY SUPPLY', [301.77, 145.00]],
  ];


  // A made-up vendor's terms, for trying "Read their terms" without hunting
  // for a real one. Invented company, invented clauses.
  var TERMS_EXAMPLE = [
    'Notewise, Inc. - Terms of Service and Privacy Notice (example)',
    '',
    '1. Your content. You own the recordings, transcripts, notes and email you connect to Notewise ("Customer Content"). You grant Notewise a licence to host, process and display Customer Content to provide the service.',
    '2. Improving our models. Notewise may use Customer Content, including meeting transcripts, to train and improve our machine learning models unless an administrator opts out in Workspace Settings > Privacy.',
    '3. Retention. We retain Customer Content for as long as your account is active and delete it within 90 days after the account is closed, except where the law requires us to keep it longer.',
    '4. Where data is stored. Customer Content is stored in data centers located in the United States.',
    '5. Subprocessors. We use subprocessors to host and process Customer Content, including Amazon Web Services and a speech-to-text provider. The current list of subprocessors is available on request.',
    '6. Security incidents. If we become aware of a security breach affecting Customer Content, we will notify the account administrator without undue delay and in any event within 72 hours.',
    '7. Data processing addendum. Customers on the Business plan may request our Data Processing Addendum (DPA) by contacting support.',
    '8. Renewal. Paid plans renew automatically at the end of each billing period at the then-current price unless cancelled.',
    '9. Cancellation. You may cancel at any time from the billing page; cancellation takes effect at the end of the current billing period and fees already paid are not refunded.',
  ].join('\n');

  function d$(n) { return n.toFixed(2); }
  function us(iso) { return iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4); }

  /** The card statement, as a bank's business-card CSV: purchases negative,
   *  a payment and a refund that must be skipped. */
  function cardCsv(today) {
    var end = C.addDays(today, -1);
    var start = C.addDays(today, -365);
    var rows = [];
    function add(date, desc, dollars, type, category) {
      if (date < start || date > end) return;
      rows.push([us(date), us(C.addDays(date, 1) > end ? date : C.addDays(date, 1)), desc, category || 'Business Services', type || 'Sale', dollars < 0 ? d$(-dollars) : '-' + d$(dollars), '']);
    }
    BILLS.forEach(function (b) {
      var desc = b[0], amt = b[1], how = b[2], off = b[3], extra = b[4] || {};
      if (how === 'monthly') {
        var last = C.addDays(today, -off);
        var firstMonth = extra.trialMonthsAgo ? extra.trialMonthsAgo - 1 : 11;
        for (var i = firstMonth; i >= 0; i--) add(C.addMonths(last, -i), desc, amt);
        if (extra.trialMonthsAgo) add(C.addDays(C.addMonths(last, -(extra.trialMonthsAgo - 1)), -14), desc, 1.00);
      } else {
        add(C.addDays(today, -off), desc, amt);
      }
    });
    // The trial that converts in three days: a $1 card check eleven days ago.
    add(C.addDays(today, -11), 'POSTCRAFT.IO TRIAL', 1.00);
    NOISE.forEach(function (n, k) {
      n[1].forEach(function (amt, i) { add(C.addDays(today, -(10 + ((i * 29 + k * 7) % 340))), n[0], amt, 'Sale', 'Supplies'); });
    });
    for (var m = 1; m <= 11; m++) add(C.addMonths(C.addDays(today, -3), -m), 'AUTOMATIC PAYMENT - THANK YOU', -2500 - m * 40, 'Payment', '');
    add(C.addDays(today, -60), 'AMAZON.COM*RETURN AMZN.COM/BILL WA', -39.99, 'Return', 'Supplies');
    rows.sort(function (a, b) { return a[0].slice(6) + a[0].slice(0, 5) < b[0].slice(6) + b[0].slice(0, 5) ? 1 : -1; });
    var head = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo';
    return head + '\n' + rows.map(function (r) { return r.map(function (c) { return /[",]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(','); }).join('\n') + '\n';
  }

  var G = 'https://www.googleapis.com/auth/';
  /** A Google Workspace app-access export: app, users, the scopes granted. */
  function workspaceCsv() {
    var apps = [
      ['Google Chrome', 'Web application', 48, G + 'userinfo.email'],
      ['Android device', 'Android', 31, G + 'userinfo.email'],
      ['iOS Account Manager', 'iOS', 22, G + 'userinfo.email ' + G + 'calendar ' + G + 'contacts'],
      ['Zoom', 'Web application', 22, G + 'userinfo.email ' + G + 'calendar.events'],
      ['Notewise', 'Web application', 14, G + 'gmail.readonly ' + G + 'calendar.readonly ' + G + 'drive.readonly ' + G + 'userinfo.email'],
      ['Canva', 'Web application', 6, G + 'userinfo.email ' + G + 'drive.file'],
      ['Bookwell', 'Web application', 4, G + 'userinfo.email ' + G + 'calendar'],
      ['HomeworkHero', 'Web application', 5, G + 'userinfo.email ' + G + 'classroom.rosters.readonly ' + G + 'classroom.coursework.students.readonly'],
      ['Formly', 'Web application', 3, G + 'userinfo.email ' + G + 'drive.file'],
      ['Flowbridge', 'Web application', 2, G + 'drive ' + G + 'gmail.modify'],
      ['Quillmate AI', 'Web application', 7, G + 'userinfo.email ' + G + 'documents'],
      ['Taskloft', 'Web application', 6, G + 'userinfo.email ' + G + 'drive.file'],
      ['Readsy', 'Web application', 3, G + 'userinfo.email'],
      ['InkSwift', 'Web application', 4, G + 'userinfo.email ' + G + 'drive.readonly'],
      ['1Password', 'Web application', 9, G + 'userinfo.email'],
      ['Mailchimp', 'Web application', 3, G + 'userinfo.email ' + G + 'contacts.readonly'],
    ];
    var lines = ['App name,Type,ID,Verified status,Users,Scopes'];
    apps.forEach(function (a, i) {
      lines.push([a[0], a[1], (100000000000 + i * 7919) + '.apps.googleusercontent.com', i % 3 ? 'Verified' : 'Unverified', a[2], '"' + a[3] + '"'].join(','));
    });
    return lines.join('\n') + '\n';
  }

  // What the library's IT lead has already written down, by tool key.
  // `probable` left true keeps "probably software - check" on show.
  var DECIDED = {
    'k:gworkspace': { status: 'approved', owner: 'Dana Ruiz (IT)', contract: 'signed', contractEnd: 210, dpa: true, data: ['employee', 'customer', 'confidential'], sso: true, users: 48 },
    'k:zoom': { status: 'approved', owner: 'Dana Ruiz (IT)', contract: 'clickthrough', dpa: true, data: ['confidential'], sso: true },
    'k:canva': { status: 'approved', owner: 'Priya Shah (Comms)', contract: 'clickthrough', data: ['confidential'], sso: true },
    'k:adobe': { status: 'approved', owner: 'Priya Shah (Comms)', contract: 'clickthrough', data: ['confidential'], sso: true, users: 2 },
    'k:mailchimp': { status: 'approved', owner: 'Priya Shah (Comms)', contract: 'clickthrough', dpa: true, data: ['customer'], sso: true },
    'k:docusign': { status: 'approved', owner: 'Marcus Lee (Finance)', contract: 'signed', contractEnd: 120, dpa: true, data: ['customer', 'confidential'], sso: true, users: 5 },
    'k:quickbooks': { status: 'approved', owner: 'Marcus Lee (Finance)', contract: 'signed', dpa: true, data: ['financial'], sso: true, users: 2 },
    'k:gusto': { status: 'approved', owner: 'Marcus Lee (Finance)', contract: 'signed', dpa: true, data: ['employee', 'financial'], sso: true, users: 3 },
    'k:surveymonkey': { status: 'review', owner: 'Priya Shah (Comms)', contract: 'clickthrough', dpa: true, data: ['customer'], sso: true, users: 2 },
    'k:1password': { status: 'approved', owner: 'Dana Ruiz (IT)', contract: 'signed', data: ['confidential'], sso: true },
    'k:squarespace': { status: 'approved', owner: 'Priya Shah (Comms)', contract: 'clickthrough', dpa: true, data: ['customer'], sso: true, users: 2 },
    'k:godaddy': { status: 'approved', owner: 'Dana Ruiz (IT)', contract: 'clickthrough', data: ['none'], sso: true, users: 1 },
    flowbridge: { cat: 'dev', status: 'unapproved', notes: 'Automation: someone in Programs connected it to their mail and Drive.' },
    taskloft: { status: 'unapproved', data: ['confidential'] },
    signupster: { cat: 'scheduling', status: 'unapproved', data: ['customer'], users: 2 },
    bookwell: { cat: 'scheduling', status: 'unapproved', data: ['customer'] },
    notewise: { status: 'unapproved', notes: 'AI note-taker. Joins meetings and reads mail and calendars for whoever signs in.' },
    homeworkhero: { status: 'review', owner: 'Jordan Kim (Teen Services)', contract: 'clickthrough', data: ['student'], notes: 'After-school homework help. Pulls class rosters from the schools’ Google Classroom.' },
    formly: { cat: 'forms', status: 'unapproved', data: ['customer'], notes: 'Program sign-up forms: names, emails, children’s ages.' },
    inkswift: { status: 'unapproved', owner: 'Maria Lopez (Branch Ops)', contract: 'clickthrough', data: ['customer'], notes: 'Room-rental agreements at two branches. DocuSign does the rest.' },
    shelfscout: { status: 'approved', owner: 'Ana Patel (Collections)', contract: 'signed', contractEnd: 52, dpa: true, data: ['none'], sso: true, users: 4 },
    readsy: { cat: 'edu', status: 'unapproved', owner: 'Maria Lopez (Branch Ops)', data: ['customer'], notes: 'Summer reading challenge for patrons.' },
    volunteerly: { cat: 'scheduling', status: 'unapproved', data: ['customer'], users: 2 },
    grantwell: { cat: 'finance', status: 'approved', owner: 'Marcus Lee (Finance)', contract: 'signed', dpa: true, data: ['financial'], sso: true, users: 2 },
    printdesk: { cat: 'other', status: 'approved', owner: 'Dana Ruiz (IT)', contract: 'signed', dpa: true, data: ['customer'], sso: true, users: 12 },
    kiosko: { cat: 'scheduling', status: 'review', owner: 'Maria Lopez (Branch Ops)', contract: 'clickthrough', data: ['customer'], users: 6 },
    quillmate: { status: 'unapproved', data: ['confidential'] },
    postcraft: { cat: 'marketing', status: 'unapproved', owner: 'Priya Shah (Comms)', data: ['confidential'], notes: 'Social-media scheduling trial.' },
    brightdesk: { status: 'unapproved', probable: true },
  };

  /** Every made-up file, as the import screen would read them. */
  function files(today) {
    return { card: [{ name: 'harbor-county-pcard.csv', text: cardCsv(today) }], access: [{ name: 'workspace-apps.csv', text: workspaceCsv() }] };
  }

  /** The whole example, through the same rules as a real import. */
  function build(today) {
    var f = files(today);
    var p = C.parseStatements(f.card);
    var card = C.findSoftware(p.transactions, { today: today });
    var access = C.parseAccess(f.access[0].text);
    var tools = C.mergeSources([card.tools, access.apps]);
    tools = tools.map(function (t) {
      var d = DECIDED[t.key];
      if (!d) return t;
      var patch = Object.assign({}, d);
      if (typeof d.contractEnd === 'number') patch.contractEnd = C.addDays(today, d.contractEnd);
      if (patch.probable !== true) patch.probable = false;
      return C.cleanTool(Object.assign({}, t, patch));
    });
    return {
      org: ORG,
      tools: tools,
      report: { charges: card.considered, notSoftware: card.notSoftware, skipped: p.skipped, range: p.range, apps: access.apps.length, builtin: access.builtin },
      requests: [
        { id: 'qsample00001', tool: 'StoryLoom', name: 'Maya (Children’s desk)', why: 'Kids record themselves reading for the summer challenge. Parents asked for it.', data: ['customer'], trial: 'yes', users: 3, status: 'open', at: C.addDays(today, -1) },
        { id: 'qsample00002', tool: 'Quillmate AI', name: 'Leo (Programs)', why: 'Drafting event descriptions and grant letters.', data: ['confidential'], trial: 'no', users: 7, status: 'open', at: C.addDays(today, -3) },
      ],
    };
  }

  return { ORG: ORG, TERMS_EXAMPLE: TERMS_EXAMPLE, cardCsv: cardCsv, workspaceCsv: workspaceCsv, files: files, build: build, DECIDED: DECIDED };
}));
