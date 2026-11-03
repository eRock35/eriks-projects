/* Lastday - the demo. A MADE-UP dental practice: Harbor & Pine Dental, 14
 * staff, looked after by an outside IT provider. Every person, address and
 * number here is invented; every address is at harborpine.example (or its
 * alias harborpinedental.example), one outside accountant's at
 * ledgerworks-cpa.example - reserved names that can never be real.
 *
 * It is written as CSV files with the headers each kind of export carries,
 * so the demo goes through exactly the same reading, column guessing and
 * matching as anyone's own files. Dates count back from the day the page
 * hands in, so the story is the same on any day:
 *
 *   - Jordan Reyes, a hygienist, suspended in the identity provider 94 days
 *     ago - still a Company admin in Accounting (critical), and active in
 *     File share and Video meetings; already off in Team chat
 *   - Wren Halvorsen, an associate dentist, deprovisioned 41 days ago -
 *     still a Team admin in File share (critical), Team chat, Video meetings
 *   - Casey Morgan, a front-desk temp never added to the identity provider -
 *     still in Team chat
 *   - reception@ (Team chat, File share) and svc-scanner@ (File share):
 *     shared and service accounts
 *   - Pat Delgado, the outside accountant, at another domain: external
 *   - Marcus Bell, 133 days without a video call: dormant
 *   - Felix Brandt's accounting login uses a short address, matched by name;
 *     Dana's file-share address carries a +files tag; Hana's chat address is
 *     at the alias domain; Lena's video address is in capitals
 *
 * And the leaver email: Dana, the office manager, writes that Sam Okafor's
 * last day is Friday. Nothing here makes a request, reads a clock or touches
 * storage.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LastdayDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var AT = String.fromCharCode(64);
  var DOM = 'harborpine.example';
  var mail = function (local, dom) { return local + AT + (dom || DOM); };

  function dayNum(iso) { return Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000); }
  function back(today, n) { return new Date((dayNum(today) - n) * 86400000).toISOString().slice(0, 10); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function us(iso) { return iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4); }
  function words(iso) { return MON[+iso.slice(5, 7) - 1] + ' ' + (+iso.slice(8, 10)) + ', ' + iso.slice(0, 4); }
  function csv(rows) { return rows.map(function (r) { return r.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\r\n') + '\r\n'; }

  // The practice's people: [first, last, local part, title].
  var STAFF = [
    ['Maya', 'Lindqvist', 'maya.lindqvist', 'Dentist and owner'],
    ['Theo', 'Abernathy', 'theo.abernathy', 'Dentist'],
    ['Ada', 'Mensah', 'ada.mensah', 'Associate dentist'],
    ['Dana', 'Whitlock', 'dana.whitlock', 'Office manager'],
    ['Sam', 'Okafor', 'sam.okafor', 'Front desk coordinator'],
    ['Hana', 'Sato', 'hana.sato', 'Front desk'],
    ['Ruby', 'Castellano', 'ruby.castellano', 'Billing coordinator'],
    ['Felix', 'Brandt', 'felix.brandt', 'Insurance and billing'],
    ['Lena', 'Fischer', 'lena.fischer', 'Hygienist'],
    ['Marcus', 'Bell', 'marcus.bell', 'Hygienist'],
    ['Ines', 'Carvalho', 'ines.carvalho', 'Dental assistant'],
    ['Owen', 'Pryce', 'owen.pryce', 'Dental assistant'],
    ['Nora', 'Quinn', 'nora.quinn', 'Sterilization technician'],
    ['Ezra', 'Kim', 'ezra.kim', 'Treatment coordinator'],
  ];
  var LOGIN_AGO = [0, 1, 2, 0, 0, 0, 3, 1, 1, 4, 2, 5, 6, 1];

  function idp(today) {
    var stamp = function (n, hh) { return back(today, n) + 'T' + (hh || '08:41:07') + '.000Z'; };
    var rows = [['Username', 'First name', 'Last name', 'Primary email', 'Title', 'Status', 'Last login', 'Status changed']];
    STAFF.forEach(function (p, i) { rows.push([mail(p[2]), p[0], p[1], mail(p[2]), p[3], 'ACTIVE', stamp(LOGIN_AGO[i]), '']); });
    rows.push([mail('jordan.reyes'), 'Jordan', 'Reyes', mail('jordan.reyes'), 'Hygienist', 'SUSPENDED', stamp(95, '16:58:12'), stamp(94, '17:30:00')]);
    rows.push([mail('wren.halvorsen'), 'Wren', 'Halvorsen', mail('wren.halvorsen'), 'Associate dentist', 'DEPROVISIONED', stamp(42, '17:02:44'), stamp(41, '09:00:00')]);
    return { name: 'okta-users-harbor-pine.csv', text: csv(rows) };
  }

  function chat(today) {
    var rows = [['Full name', 'Email', 'Account type', 'Last active']];
    var t = function (p, type, ago, address) { rows.push([p[0] + ' ' + p[1], address || mail(p[2]), type, words(back(today, ago))]); };
    t(STAFF[0], 'Workspace Owner', 0);
    t(STAFF[3], 'Workspace Admin', 0);
    t(STAFF[1], 'Member', 1); t(STAFF[2], 'Member', 2); t(STAFF[4], 'Member', 0);
    t(STAFF[5], 'Member', 0, mail('hana.sato', 'harborpinedental.example'));
    t(STAFF[6], 'Member', 3); t(STAFF[7], 'Member', 1); t(STAFF[8], 'Member', 1); t(STAFF[9], 'Member', 4);
    t(STAFF[10], 'Member', 2); t(STAFF[11], 'Member', 5); t(STAFF[12], 'Member', 6); t(STAFF[13], 'Member', 1);
    rows.push(['Casey Morgan', mail('casey.morgan'), 'Member', words(back(today, 51))]);
    rows.push(['Wren Halvorsen', mail('wren.halvorsen'), 'Member', words(back(today, 43))]);
    rows.push(['Jordan Reyes', mail('jordan.reyes'), 'Deactivated', words(back(today, 96))]);
    rows.push(['Front Desk', mail('reception'), 'Member', words(back(today, 0))]);
    return { name: 'team-chat-members.csv', label: 'Team chat', text: csv(rows) };
  }

  function accounting(today) {
    var rows = [['User', 'Email address', 'User type', 'Status', 'Last login']];
    rows.push(['Maya Lindqvist', mail('maya.lindqvist'), 'Master admin', 'Active', us(back(today, 6))]);
    rows.push(['Dana Whitlock', mail('dana.whitlock'), 'Company admin', 'Active', us(back(today, 1))]);
    rows.push(['Felix Brandt', mail('felix.b'), 'Standard - all access', 'Active', us(back(today, 2))]);
    rows.push(['Ruby Castellano', mail('ruby.castellano'), 'Standard - limited', 'Active', us(back(today, 3))]);
    rows.push(['Jordan Reyes', mail('jordan.reyes'), 'Company admin', 'Active', us(back(today, 97))]);
    rows.push(['Pat Delgado', mail('pat', 'ledgerworks-cpa.example'), 'Accountant', 'Active', us(back(today, 12))]);
    return { name: 'accounting-users.csv', label: 'Accounting', text: csv(rows) };
  }

  function files(today) {
    var rows = [['Name', 'Email', 'Role', 'Last activity', 'Storage used']];
    var r = function (name, address, role, ago, gb) { rows.push([name, address, role, back(today, ago), gb + ' GB']); };
    r('Maya Lindqvist', mail('maya.lindqvist'), 'Team admin', 0, 41.2);
    r('Dana Whitlock', mail('dana.whitlock+files'), 'Member', 1, 18.7);
    r('Theo Abernathy', mail('theo.abernathy'), 'Member', 3, 9.4);
    r('Ada Mensah', mail('ada.mensah'), 'Member', 8, 3.1);
    r('Sam Okafor', mail('sam.okafor'), 'Member', 1, 6.8);
    r('Felix Brandt', mail('felix.brandt'), 'Member', 2, 12.5);
    r('Lena Fischer', mail('lena.fischer'), 'Member', 9, 2.2);
    r('Jordan Reyes', mail('jordan.reyes'), 'Member', 95, 7.9);
    r('Wren Halvorsen', mail('wren.halvorsen'), 'Team admin', 42, 22.6);
    r('Reception', mail('reception'), 'Member', 0, 30.4);
    r('Scanner', mail('svc-scanner'), 'Member', 0, 54.0);
    return { name: 'file-share-team-members.csv', label: 'File share', text: csv(rows) };
  }

  function video(today) {
    var rows = [['Email', 'First Name', 'Last Name', 'User Type', 'Role', 'Last Sign In']];
    var v = function (address, first, last, type, role, ago) { rows.push([address, first, last, type, role, back(today, ago).replace(/-/g, '/') + ' 09:14']); };
    v(mail('maya.lindqvist'), 'Maya', 'Lindqvist', 'Licensed', 'Owner', 1);
    v(mail('dana.whitlock'), 'Dana', 'Whitlock', 'Licensed', 'Admin', 0);
    v(mail('Lena.Fischer', 'HarborPine.example'), 'Lena', 'Fischer', 'Licensed', 'Member', 2);
    v(mail('theo.abernathy'), 'Theo', 'Abernathy', 'Licensed', 'Member', 3);
    v(mail('ada.mensah'), 'Ada', 'Mensah', 'Basic', 'Member', 15);
    v(mail('sam.okafor'), 'Sam', 'Okafor', 'Licensed', 'Member', 2);
    v(mail('marcus.bell'), 'Marcus', 'Bell', 'Licensed', 'Member', 133);
    v(mail('ezra.kim'), 'Ezra', 'Kim', 'Basic', 'Member', 7);
    v(mail('jordan.reyes'), 'Jordan', 'Reyes', 'Licensed', 'Member', 96);
    v(mail('wren.halvorsen'), 'Wren', 'Halvorsen', 'Basic', 'Member', 45);
    return { name: 'video-meetings-users.csv', label: 'Video meetings', text: csv(rows) };
  }

  /** The five files, as the page reads them. */
  function exportsFor(today) { return { idp: idp(today), apps: [chat(today), accounting(today), files(today), video(today)] }; }

  /** The practice's systems and settings - what the outside IT provider keeps. */
  function inventory() {
    return {
      version: 1,
      systems: [
        { id: 'idp', name: 'Identity provider', sso: true, steps: ['disable', 'sessions', 'mfa'], owner: 'msp' },
        { id: 'email', name: 'Email and calendar', sso: true, steps: ['sessions', 'tokens', 'mailbox', 'licence'], owner: 'msp' },
        { id: 'chat', name: 'Team chat', sso: true, steps: ['disable', 'sessions', 'tokens'], owner: 'msp' },
        { id: 'files', name: 'File share', sso: false, steps: ['disable', 'files', 'licence'], owner: 'office' },
        { id: 'video', name: 'Video meetings', sso: false, steps: ['disable', 'licence'], owner: 'office' },
        { id: 'accounting', name: 'Accounting', sso: false, steps: ['disable', 'rotate'], owner: 'office' },
        { id: 'records', name: 'Patient records system', sso: false, steps: ['disable', 'rotate'], owner: 'office' },
        { id: 'devices', name: 'Laptops and phones', sso: false, steps: ['devices', 'hardware'], owner: 'msp' },
        { id: 'building', name: 'Door, alarm and Wi-Fi', sso: false, steps: ['rotate'], owner: 'office' },
      ],
      settings: { domains: [DOM, 'harborpinedental.example'], dormantDays: 90, idp: 'okta' },
      updatedAt: 0,
    };
  }

  /** The leaver email the office manager sent the IT provider. */
  function request() {
    return [
      'From: Dana Whitlock <' + mail('dana.whitlock') + '>',
      'To: Tidewater IT Help Desk <' + mail('help', 'tidewater-it.example') + '>',
      'Subject: Leaver - Sam Okafor',
      '',
      'Hi team,',
      '',
      'Sam Okafor’s last day is Friday - they’re moving on to a practice closer to home. Their address is ' + mail('sam.okafor') + '.',
      '',
      'Please keep their mailbox for the office manager (me) so patient emails don’t get lost, and give their files to Hana Sato, who is taking over front desk scheduling. Sam has a practice laptop and the front door key fob to hand back.',
      '',
      'Thanks,',
      'Dana Whitlock',
      'Office manager, Harbor & Pine Dental',
      '207-555-0143',
    ].join('\n');
  }

  /** A messier one, for trying the AI reader: no dates spelled out, a
   *  nickname, the leaver never named in full. */
  function messyRequest() {
    return [
      'quick one - Jojo from the hygiene team won’t be back after the 14th, HR has the paperwork. ',
      'can u make sure the shared front desk login + the alarm code get changed, theyve had both for years. ',
      'their stuff in the drive should probably go to whoever covers hygiene, ask Maya. ',
      'not a happy exit so pls do it the morning of, before they come in. thx - D',
    ].join('');
  }

  return { exportsFor: exportsFor, inventory: inventory, request: request, messyRequest: messyRequest, STAFF: STAFF, DOMAIN: DOM, mail: mail };
}));
