/* Drill - the rules and the scenarios, in one file. Rehearse the bad day
 * before it happens.
 *
 * Run three times: by the page (window.DrillCore), by the server and by the
 * tests (require). UMD, no dependencies, no clock and no dice of its own:
 * the same decisions give the same score and the same report on every
 * phone, in a room or solo.
 *
 * What is here:
 *   - cleaning: one door for every typed string (no markup, no control or
 *     bidi characters, bounded, cut on a whole character);
 *   - the roles, the seven checklist areas and the checklist items every
 *     scenario tests (each with what "good" looks like, the fix and who
 *     owns it);
 *   - the built-in scenarios: timed injects, each addressed to a role, with
 *     two to four choices that carry a consequence, the items they test and
 *     where the story goes next;
 *   - cleanScenario: the one door a scenario comes through, built-in or
 *     written by a model, so a custom scenario is held to exactly the rules
 *     the built-ins are tested against;
 *   - the clock ("Mon 8:57 AM · 45 minutes in"), the score, and the
 *     after-action report as an object, as Markdown and as a printable page.
 *
 * Not legal advice, anywhere: a regulator clock is always "check the rules
 * where you operate", with examples, never "you must".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DrillCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    name: 24,          // a first name
    org: 60,           // "Who is this for?" on the report, optional
    title: 60,
    blurb: 200,
    injectTitle: 70,
    injectText: 420,
    choiceText: 180,
    thenText: 300,
    minInjects: 6,
    maxInjects: 9,
    minChoices: 2,
    maxChoices: 4,
    maxTests: 3,
    maxAt: 7 * 24 * 60,   // a scenario runs at most a week of scenario time
    about: 600,        // "Make it about us": what the business does
    tools: 300,        // and the tools it uses
    library: 12,       // custom scenarios kept per account
    people: 24,        // people in one room
  };

  /* ------------------------------------------------------------------ *
   * Cleaning
   * ------------------------------------------------------------------ */

  // Control characters and the bidi overrides and isolates never belong in
  // a name or a scenario. The zero-width joiner stays: emoji need it.
  const STRIP = /[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁩﻿]/g;

  /** One line of untrusted text: no markup, no control or bidi characters,
   *  single spaces, at most `max` characters. Cut before any pattern runs,
   *  so hostile input costs linear time. */
  function clean(v, max) {
    let s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** The same, but it has to say something: a letter, a digit or an emoji. */
  function cleanText(v, max) {
    const s = clean(v, max);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  const cleanName = (v) => cleanText(v, LIMITS.name);
  const cleanOrg = (v) => cleanText(v, LIMITS.org);
  function fold(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  const own = (o, k) => Boolean(o) && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

  /* ------------------------------------------------------------------ *
   * Roles, areas and the checklist
   * ------------------------------------------------------------------ */

  const ROLES = [
    { id: 'owner', label: 'Owner', emoji: '🧭', blurb: 'Owner or manager: in charge, makes the call' },
    { id: 'it', label: 'IT', emoji: '🖥️', blurb: 'Whoever looks after the computers' },
    { id: 'ops', label: 'Ops', emoji: '🗂️', blurb: 'Office manager, operations, keeps things running' },
    { id: 'comms', label: 'Comms', emoji: '📣', blurb: 'Customers, social, press' },
    { id: 'finance', label: 'Finance', emoji: '💳', blurb: 'Payments, the bank, the insurer' },
    { id: 'legal', label: 'Legal/HR', emoji: '⚖️', blurb: 'Staff, contracts, the lawyer’s number' },
  ];
  const ROLE_IDS = ROLES.map((r) => r.id);
  const roleOf = (id) => ROLES.find((r) => r.id === id) || null;

  const AREAS = [
    { id: 'lead', label: 'Command', blurb: 'One person in charge, one channel, a record' },
    { id: 'contain', label: 'Contain it', blurb: 'Stop the damage spreading' },
    { id: 'evidence', label: 'Preserve evidence', blurb: 'Keep the trail before you clean up' },
    { id: 'insurer', label: 'Insurer & experts', blurb: 'Call the policy’s hotline early' },
    { id: 'rules', label: 'Rules & reporting', blurb: 'Regulator clocks, counsel, the authorities' },
    { id: 'people', label: 'Customers & staff', blurb: 'Tell people clearly, one story' },
    { id: 'recover', label: 'Recover', blurb: 'Restore, roll back, keep trading' },
  ];
  const AREA_IDS = AREAS.map((a) => a.id);

  // Every scenario - built-in or custom - tests items from this one list, so
  // reports read the same whichever drill was run. `good` is what the report
  // says went well; `fix` and `owner` are what it puts on the action list.
  const ITEMS = {
    l_lead: { area: 'lead', label: 'One person in charge', good: 'Someone took charge early and the team knew who it was.', fix: 'Name an incident lead and a deputy, and agree a backup channel (a group text) for when email is down.', owner: 'owner' },
    l_verify: { area: 'lead', label: 'Verify by a second channel', good: 'Nobody acted on an instruction until it was checked on a known number.', fix: 'Make it a rule: any payment or bank-detail change is confirmed by a call to a number you already have, and two people approve large payments.', owner: 'finance' },
    e_log: { area: 'evidence', label: 'Keep a timeline', good: 'Decisions were written down with the time, so the story can be told later.', fix: 'Name a scribe for every incident and keep a shared incident-log template ready.', owner: 'ops' },
    e_preserve: { area: 'evidence', label: 'Preserve evidence', good: 'Logs and affected machines were kept before anything was wiped or restored.', fix: 'Agree the rule: snapshot or image before you rebuild, and keep sign-in and system logs for at least 90 days.', owner: 'it' },
    c_isolate: { area: 'contain', label: 'Isolate affected systems', good: 'Affected machines came off the network fast, without destroying what was on them.', fix: 'Write a one-page “how to isolate a machine” for every site and practise it twice a year.', owner: 'it' },
    c_access: { area: 'contain', label: 'Cut off access', good: 'Accounts, passwords and sessions were shut off at the source.', fix: 'List every admin account, API key and leaver’s login, and who can revoke each in ten minutes.', owner: 'it' },
    c_money: { area: 'contain', label: 'Stop the money moving', good: 'The bank’s fraud line was called while a recall could still work.', fix: 'Put your bank’s 24/7 fraud number and recall steps on the incident card.', owner: 'finance' },
    c_killswitch: { area: 'contain', label: 'Switch off the automation', good: 'The AI agent or automation was switched off at its access, not argued with.', fix: 'Give every AI agent and automation an off switch, write down where it is, and name who may pull it.', owner: 'ops' },
    i_call: { area: 'insurer', label: 'Call the insurer early', good: 'The insurer’s breach line was called before anything was promised or paid.', fix: 'Print the policy number and the insurer’s 24/7 breach line on the incident card, and read what needs their approval first.', owner: 'finance' },
    i_experts: { area: 'insurer', label: 'Bring in the right help', good: 'Help came from responders the policy allows, not whoever was nearest.', fix: 'Pick an incident-response firm now - your insurer may have a panel - and save their number.', owner: 'owner' },
    r_clock: { area: 'rules', label: 'Start the regulator clock', good: 'The team noted when it found out and checked which breach rules apply where it operates.', fix: 'With your lawyer, write down which breach-notice rules may apply where you and your customers are (for example GDPR’s 72 hours, or a US state breach law) and who checks them.', owner: 'legal' },
    r_counsel: { area: 'rules', label: 'Get legal advice first', good: 'Nothing was admitted, promised or sent in writing before counsel saw it.', fix: 'Choose a lawyer you would call in an incident and keep their number on the incident card.', owner: 'legal' },
    r_report: { area: 'rules', label: 'Report the crime', good: 'The crime was reported to the authorities where you operate.', fix: 'Find out now where fraud and cybercrime are reported where you operate (for example the FBI’s IC3 in the US, or Action Fraud in the UK).', owner: 'legal' },
    p_customers: { area: 'people', label: 'Tell customers clearly', good: 'Affected customers heard what happened, what it means for them and who to contact.', fix: 'Draft holding statements now for a data breach and for an outage, so the first message is never written in a panic.', owner: 'comms' },
    p_staff: { area: 'people', label: 'Give staff one story', good: 'Staff had the same short script and one place to send questions.', fix: 'Write a three-line staff script template and agree where staff send questions they can’t answer.', owner: 'comms' },
    v_backup: { area: 'recover', label: 'Restore from tested backups', good: 'Backups were checked before they were trusted.', fix: 'Test-restore your most important system this month, and keep one backup copy offline or offsite.', owner: 'it' },
    v_rollback: { area: 'recover', label: 'Roll back the last change', good: 'The last change was rolled back before anyone debugged forward.', fix: 'Keep a one-step rollback for the website and know who can press it.', owner: 'it' },
    v_trading: { area: 'recover', label: 'Keep trading', good: 'The business kept serving customers with a workaround.', fix: 'Write down the manual fallback for taking orders, payments and payroll if the systems are down for a day.', owner: 'ops' },
  };
  const ITEM_IDS = Object.keys(ITEMS);

  /* ------------------------------------------------------------------ *
   * The scenarios
   *
   * Each inject: {id, at (minutes of scenario time), to (a role), title,
   * text, tests (checklist items), choices: [{id, text, then (what
   * happens), next (an inject id or 'end'), hits ({item: 1 or 2})}]}.
   * `at` always grows along an edge, so every path ends (tested).
   * ------------------------------------------------------------------ */

  const c = (id, text, then, next, hits) => ({ id, text, then, next, hits: hits || {} });

  const SCENARIOS = [
    {
      id: 'laptop',
      demo: true,
      title: 'The laptop on the train',
      emoji: '🚆',
      blurb: 'A work laptop is gone on a Friday night - with a customer spreadsheet on the desktop. Four decisions, five minutes.',
      start: { day: 4, time: '18:40' },
      minutes: 5,
      injects: [
        { id: 'd1', at: 0, to: 'it', title: 'It’s gone', text: 'Priya from sales texts: “I left my work laptop on the train. It’s gone.” It’s signed in to her email and the customer system, with her passwords saved in the browser.', tests: ['c_access'], choices: [
          c('a', 'Lock and wipe it remotely, sign her out of everything and change her passwords', 'Done by 6:55. Whoever has the laptop now has a locked brick - and nothing it was signed in to still works.', 'd2', { c_access: 2 }),
          c('b', 'Wait - lost property might have it on Monday', 'Two days with a live laptop, signed in to everything, in someone else’s hands.', 'd2'),
          c('c', 'Change her email password only', 'Better than nothing. The customer system and her saved passwords are still open on it.', 'd2', { c_access: 1 }),
        ] },
        { id: 'd2', at: 20, to: 'owner', title: 'There’s a spreadsheet', text: 'Priya remembers: there’s a spreadsheet on the desktop with 900 customers - names, emails, phone numbers - exported for a sales campaign.', tests: ['e_log', 'l_lead'], choices: [
          c('a', 'Take charge: write down the times and facts now, and ask IT whether the disk was encrypted', 'You have a timeline from minute one, and the one question that decides how bad this is.', 'd3', { e_log: 2, l_lead: 2 }),
          c('b', 'Ask Priya to keep it quiet', 'Secrets in a small company last about a day. And nobody is writing anything down.', 'd3'),
          c('c', 'Email all 900 customers tonight to warn them', 'Fast - but you don’t yet know if the data was even readable, and you’ll be correcting this email on Monday.', 'd3', { l_lead: 1 }),
        ] },
        { id: 'd3', at: 60, to: 'legal', title: 'It wasn’t encrypted', text: 'IT checks: disk encryption was switched off on that laptop. Anyone who gets past the lock screen could read the spreadsheet.', tests: ['r_clock', 'i_call'], choices: [
          c('a', 'Note when you found out, call the insurer’s breach line, and check with a lawyer which breach rules apply where your customers are', 'The insurer opens a claim and offers a breach lawyer. Whatever clock applies, you know when it started.', 'd4', { r_clock: 2, i_call: 2 }),
          c('b', 'It’s just a lost laptop, not a hack', 'Under many breach rules an unencrypted device with customer data on it can count, hack or not.', 'd4'),
          c('c', 'Wait to see if anyone misuses the data', 'If a clock applies, it may already be running from tonight.', 'd4'),
        ] },
        { id: 'd4', at: 2880, to: 'ops', title: 'A ransom for a laptop', text: 'Sunday evening. A stranger emails: “Found your laptop. $500 in gift cards and it’s yours.”', tests: ['r_report', 'c_access'], choices: [
          c('a', 'Don’t pay or meet them - pass the email to the police and your insurer; the laptop is already wiped', 'There is nothing on it to buy back. The police have a lead, and the insurer has a note for the file.', 'end', { r_report: 2, c_access: 1 }),
          c('b', 'Pay - $500 is cheap to make it go away', 'There’s no way to know what they copied first, and now they know you pay.', 'end'),
          c('c', 'Agree to meet them in a car park', 'Please don’t. Nothing on that laptop is worth meeting a stranger for.', 'end'),
        ] },
      ],
    },
    {
      id: 'ransomware',
      title: 'Ransomware on Monday morning',
      emoji: '🔒',
      blurb: 'Files locked across the office, a ransom note on the screen, and a customer list that may already be gone.',
      start: { day: 0, time: '08:12' },
      minutes: 45,
      injects: [
        { id: 'r1', at: 0, to: 'it', title: 'The note on the screen', text: 'The front desk calls: every file on the shared drive now ends in .lockd, and there’s a note on the screen - “Your files are encrypted. Pay 2 BTC within 72 hours.” Two other PCs show the same note.', tests: ['c_isolate', 'e_preserve'], choices: [
          c('a', 'Unplug the three PCs from the network and turn off the office Wi-Fi - but leave them powered on', 'It stops at three machines. Because they’re still on, what’s in memory and the logs survive for whoever investigates.', 'r2', { c_isolate: 2, e_preserve: 2 }),
          c('b', 'Shut everything down and start restoring from last night’s backup', 'The spread stops - but switching off loses what was in memory, and restoring over the machines wipes the trail. Nobody will know how they got in.', 'r2', { c_isolate: 1 }),
          c('c', 'Ask everyone to keep working while IT looks into it', 'By 9:00 the note is on eleven machines and the accounting server.', 'r1b'),
        ] },
        { id: 'r1b', at: 50, to: 'owner', title: 'It’s spreading', text: 'Eleven machines and the accounting server are locked. Staff are standing around, and customers are calling about their orders.', tests: ['c_isolate', 'l_lead'], choices: [
          c('a', 'Pull the office off the internet at the router, say you’re in charge, and move the team to a group text', 'The spread stops. Everyone knows who’s deciding and where to talk.', 'r2', { c_isolate: 2, l_lead: 2 }),
          c('b', 'Send everyone home until it’s fixed', 'The spread slows, but nobody is running the incident and the phones go unanswered.', 'r2', { c_isolate: 1 }),
          c('c', 'Email all staff explaining what’s happening', 'The email server is one of the locked machines. Half the team never sees it.', 'r2'),
        ] },
        { id: 'r2', at: 60, to: 'owner', title: 'Who’s running this?', text: 'IT is on the floor with the machines, the phones are ringing, and the ops manager has started a reply-all thread with 14 people on it.', tests: ['l_lead', 'e_log'], choices: [
          c('a', 'You lead. Name a scribe to write down every decision with the time, and keep one group text for the team', 'IT can work. Every call from here is written down - which the insurer and any regulator will ask for.', 'r3', { l_lead: 2, e_log: 2 }),
          c('b', 'Let IT run it - they know the tech', 'IT is now fixing machines and answering you, the staff and the customers. Things fall through the cracks.', 'r3', { l_lead: 1 }),
          c('c', 'Everyone does what they can', 'Five people, five plans, no record of any of it.', 'r3'),
        ] },
        { id: 'r3', at: 90, to: 'finance', title: 'A discount for paying today', text: 'Someone finds the cyber insurance policy in a drawer. Meanwhile the ransom note’s chat window offers a “20% discount if you pay today”.', tests: ['i_call', 'i_experts'], choices: [
          c('a', 'Call the insurer’s 24/7 breach line before anyone talks to the attackers', 'They open a claim, send an incident-response firm from their panel, and tell you not to engage the attackers yourselves.', 'r4', { i_call: 2, i_experts: 2 }),
          c('b', 'Get the IT shop down the road to clean it up, and tell the insurer later', 'Your policy wanted to approve the responders first. The claim becomes an argument.', 'r4', { i_call: 1 }),
          c('c', 'Start negotiating in the chat to get the discount', 'The attackers now know you’re engaged and in a hurry.', 'r3b'),
        ] },
        { id: 'r3b', at: 150, to: 'legal', title: 'They have a copy', text: 'The attackers reply: they also copied your files, and will publish your customer list unless you pay by Wednesday.', tests: ['r_counsel', 'i_call'], choices: [
          c('a', 'Stop talking to them. Call the insurer and a lawyer now', 'Late, but the right people are involved before anything else is said in writing.', 'r4', { r_counsel: 2, i_call: 2 }),
          c('b', 'Promise to pay, to buy time', 'In writing, you have promised criminals money. Your lawyer winces when they read it.', 'r4'),
          c('c', 'Ignore it - it’s probably a bluff', 'Maybe. If it isn’t, you’ve lost two days you may need for notifying people.', 'r4'),
        ] },
        { id: 'r4', at: 240, to: 'it', title: 'Are the backups safe?', text: 'The responders ask the question that decides the week: are the backups safe? The nightly backup drive was plugged into the server.', tests: ['v_backup'], choices: [
          c('a', 'Check the offsite copy and test-restore one folder before trusting it', 'The offsite copy is clean. One folder restored in twenty minutes; you know the rest will work.', 'r5', { v_backup: 2 }),
          c('b', 'Restore everything from the plugged-in drive straight away', 'It was encrypted too. Three hours gone.', 'r5'),
          c('c', 'There’s no offsite copy - rebuild from what’s on staff laptops', 'Messy and slow. It gets some files back.', 'r5', { v_backup: 1 }),
        ] },
        { id: 'r5', at: 360, to: 'legal', title: 'Customer data was taken', text: 'The responders confirm files were copied out, including a spreadsheet of customer names, emails and order histories.', tests: ['r_clock', 'r_counsel'], choices: [
          c('a', 'Record when you found out, and with your lawyer check which breach rules apply where you and your customers are, and their deadlines', 'You know which clocks may be running and when they started - for example GDPR’s 72 hours, or a US state breach law.', 'r6', { r_clock: 2, r_counsel: 2 }),
          c('b', 'We’re too small for the rules to apply to us', 'Many breach rules apply whatever your size. You don’t know which clock is running.', 'r6'),
          c('c', 'Post on the website straight away that you’ve been hacked', 'Honest - but before you know what was taken, what to say, or what your lawyer thinks.', 'r6', { r_clock: 1 }),
        ] },
        { id: 'r6', at: 1440, to: 'comms', title: 'It’s on social', text: 'Tuesday, 8:12. A customer posts: “Has this company been hacked? I got a weird email from them.” It has 40 shares.', tests: ['p_customers', 'p_staff'], choices: [
          c('a', 'Reply with a short holding statement your lawyer has seen, give staff the same line, and email affected customers directly', 'The thread calms down. Customers hear it from you first, and staff all say the same thing.', 'r7', { p_customers: 2, p_staff: 2 }),
          c('b', 'Delete the post and say nothing', 'Someone screenshotted it. Now it’s a post about a breach and a cover-up.', 'r7'),
          c('c', 'Reply “No breach, all fine!”', 'When the truth comes out, this reply is the screenshot everyone shares.', 'r7'),
        ] },
        { id: 'r7', at: 2880, to: 'ops', title: 'Back up and running', text: 'Wednesday. Systems are back. Everyone is exhausted. What happens next?', tests: ['e_log', 'v_trading'], choices: [
          c('a', 'Hold a one-hour review this week: the timeline, what worked, and write down the paper workaround you used for orders', 'You come out with three fixes, an owner for each, and a fallback that works next time.', 'end', { e_log: 2, v_trading: 2 }),
          c('b', 'Everyone’s tired - just move on', 'In six months, nobody remembers what worked.', 'end'),
          c('c', 'Buy a new antivirus product and call it fixed', 'A product isn’t a plan.', 'end'),
        ] },
      ],
    },
    {
      id: 'leak',
      title: 'A leaked customer list',
      emoji: '📇',
      blurb: 'A journalist has your customer list and wants a comment by six. A leaver’s login still works.',
      start: { day: 3, time: '15:30' },
      minutes: 40,
      injects: [
        { id: 'l1', at: 0, to: 'comms', title: 'A journalist calls', text: 'An email from a reporter: “We’ve been sent a spreadsheet that appears to be your customer list - 4,200 names, emails and phone numbers. Any comment by 6pm?”', tests: ['l_lead', 'r_counsel'], choices: [
          c('a', 'Thank them, ask for a sample to check, say you’ll respond - then tell the owner and call your lawyer', 'You’ve bought time, you’ll know if it’s real, and the right people are in the loop.', 'l2', { l_lead: 2, r_counsel: 2 }),
          c('b', 'Reply “No comment”', 'Safe, but you’ve learned nothing, and the story will say you declined to comment.', 'l2', { r_counsel: 1 }),
          c('c', 'Reply “That’s impossible - our data is secure”', 'It’s your list. Now there’s a quote.', 'l2'),
        ] },
        { id: 'l2', at: 30, to: 'it', title: 'It’s real', text: 'The sample matches a customer-system export from March. Who could have exported it?', tests: ['e_preserve', 'c_access'], choices: [
          c('a', 'Save a copy of the system’s export and sign-in logs, then list every account that can export', 'Within the hour you have the trail - and a short list.', 'l3', { e_preserve: 2, c_access: 1 }),
          c('b', 'Delete the old user accounts and shared logins right away', 'It shuts the door - and deletes the very accounts whose history would have shown who did it.', 'l3', { c_access: 1 }),
          c('c', 'Ask in the team chat who exported it', 'Whoever did it now knows you’re looking.', 'l2b'),
        ] },
        { id: 'l2b', at: 90, to: 'owner', title: 'A leaver’s login', text: 'It turns out Jordan, a sales rep who left three weeks ago, still has a working login. It was used last night.', tests: ['c_access', 'r_counsel'], choices: [
          c('a', 'Disable Jordan’s access now, save the sign-in record, and talk to your lawyer before contacting Jordan', 'The door is shut, the evidence is kept, and nothing you say can be used against you.', 'l3', { c_access: 2, r_counsel: 2 }),
          c('b', 'Call Jordan and demand answers', 'Jordan hangs up and calls a lawyer. Their login still works.', 'l3'),
          c('c', 'Disable every account, your own team’s included, until Monday', 'It works - and sales stops for three days.', 'l3', { c_access: 1 }),
        ] },
        { id: 'l3', at: 120, to: 'legal', title: 'Customers in several places', text: 'The list has people in several US states and two EU countries.', tests: ['r_clock', 'r_counsel'], choices: [
          c('a', 'Record when you became aware, and with your lawyer check which breach rules apply - for example GDPR’s 72 hours for the EU customers, and each state’s breach law', 'You have a list of possible clocks, each with a start time and an owner.', 'l4', { r_clock: 2, r_counsel: 1 }),
          c('b', 'Wait until we know everything before starting any clock', 'Many clocks start when you become aware, not when you finish investigating.', 'l4'),
          c('c', 'Notify everyone on the list tonight, before checking anything', 'Fast - but the message will need correcting tomorrow.', 'l4', { r_clock: 1 }),
        ] },
        { id: 'l4', at: 150, to: 'finance', title: 'Are we covered?', text: 'Does your insurance cover this? Nobody in the room knows.', tests: ['i_call'], choices: [
          c('a', 'Call the cyber policy’s breach hotline today', 'Many policies cover the lawyer, the notification letters and credit monitoring - if you tell them promptly.', 'l5', { i_call: 2 }),
          c('b', 'We’ll handle it ourselves - insurance is for disasters', 'Lawyers, letters and monitoring for 4,200 people add up fast.', 'l5'),
          c('c', 'Tell the insurer after the notices are sent', 'They may have wanted a say in what the notices said.', 'l5', { i_call: 1 }),
        ] },
        { id: 'l5', at: 1080, to: 'comms', title: 'The story is live', text: 'Friday, 9:30. The article is up: “Local firm leaks 4,200 customers’ data.” Customer emails are piling up.', tests: ['p_customers', 'p_staff'], choices: [
          c('a', 'Email affected customers - what happened, what data, what you’re doing, what to watch out for, who to contact - agreed with your lawyer', 'Most replies are “thanks for telling us”. A few want to talk, and know who to call.', 'l6', { p_customers: 2, p_staff: 1 }),
          c('b', 'Post a statement on the website only', 'Most customers never see it.', 'l6', { p_customers: 1 }),
          c('c', 'Let staff answer each email however they think best', 'Eight people, eight different stories.', 'l5b'),
        ] },
        { id: 'l5b', at: 1140, to: 'ops', title: 'A screenshot', text: 'A staff member told a customer “it was Jordan, he’s a crook.” It’s been screenshotted.', tests: ['p_staff', 'r_counsel'], choices: [
          c('a', 'Give every staff member the same three-line script and one address for questions, and loop in your lawyer about the comment', 'The next hundred replies say the same thing - and none of them names anyone.', 'l6', { p_staff: 2, r_counsel: 1 }),
          c('b', 'Discipline the staff member publicly', 'Now there are two stories.', 'l6'),
          c('c', 'Tell staff not to talk to anyone at all', 'Safer than rumours, but customers get no answer.', 'l6', { p_staff: 1 }),
        ] },
        { id: 'l6', at: 5760, to: 'owner', title: 'Never again', text: 'Monday. Time to make sure this can’t happen the same way twice.', tests: ['c_access', 'e_log'], choices: [
          c('a', 'Add “remove access” to the leaver checklist, turn on export alerts, and review it with the timeline', 'The next leaver is locked out on their last day, and a big export pings someone.', 'end', { c_access: 2, e_log: 2 }),
          c('b', 'Ban exports entirely', 'By Wednesday sales has a workaround: screenshots.', 'end', { c_access: 1 }),
          c('c', 'It was one bad apple - move on', 'The next leaver’s login works too.', 'end'),
        ] },
      ],
    },
    {
      id: 'agent',
      title: 'The AI agent that emailed the wrong people',
      emoji: '🤖',
      blurb: 'Day one of your new AI support agent: it is sending customers other customers’ orders.',
      start: { day: 1, time: '10:05' },
      minutes: 40,
      injects: [
        { id: 'a1', at: 0, to: 'ops', title: 'Day one', text: 'Your new AI support agent went live at 7am. A customer forwards an email it sent her: it includes another customer’s order and home address. Support has two more like it.', tests: ['c_killswitch', 'e_preserve'], choices: [
          c('a', 'Switch it off now - pause it and revoke its email access - and keep its logs and prompts exactly as they are', 'It stops at 10:09 AM. Everything it did today is still there to read.', 'a2', { c_killswitch: 2, e_preserve: 2 }),
          c('b', 'Edit the prompt to tell it to stop sharing order details, and leave it running', 'It keeps answering. A prompt is a suggestion, not a lock.', 'a1b'),
          c('c', 'Switch it off and delete its conversation history so nothing else leaks', 'The leak stops. So does any way of knowing who received what.', 'a2', { c_killswitch: 2 }),
        ] },
        { id: 'a1b', at: 40, to: 'it', title: 'Still running', text: 'It’s still going: 31 replies since the prompt change, some with attachments from other customers’ tickets.', tests: ['c_killswitch', 'c_access'], choices: [
          c('a', 'Revoke its API keys and mailbox access at the source', 'It goes quiet within a minute, whatever it “thinks”.', 'a2', { c_killswitch: 2, c_access: 2 }),
          c('b', 'Ask the vendor to look into it', 'Their support queue says 24 to 48 hours.', 'a2'),
          c('c', 'Unplug the office internet', 'The agent runs in the cloud. It keeps going.', 'a2', { c_killswitch: 1 }),
        ] },
        { id: 'a2', at: 60, to: 'it', title: 'Who got what?', text: 'The agent sent 212 emails since 7am. Which ones carried someone else’s data?', tests: ['e_preserve', 'e_log'], choices: [
          c('a', 'Export its send log, match each email to what it contained, and keep the export read-only', 'By lunch you know: 18 emails, 18 people affected, and exactly what each one saw.', 'a3', { e_preserve: 2, e_log: 2 }),
          c('b', 'Email all 212 recipients “please ignore our last email”', 'Now 212 people go looking for what to ignore.', 'a3'),
          c('c', 'Ask the vendor for a list later', 'Maybe. The vendor’s logs are theirs, kept their way.', 'a3', { e_preserve: 1 }),
        ] },
        { id: 'a3', at: 120, to: 'legal', title: 'Personal data, several countries', text: 'Eighteen emails contained another person’s name, address and order history. Some recipients are in Canada and the UK.', tests: ['r_clock', 'r_counsel'], choices: [
          c('a', 'Treat it as a possible personal-data breach: note the time, and with your lawyer check the rules where those customers live and their deadlines', 'You have the possible clocks written down, each with when it started.', 'a4', { r_clock: 2, r_counsel: 2 }),
          c('b', 'The AI did it, not us - so no rules apply', 'Most rules care who is responsible for the data, not which tool sent it.', 'a4'),
          c('c', 'Wait and see if anyone complains', 'If a clock applies, it is already running.', 'a4'),
        ] },
        { id: 'a4', at: 180, to: 'finance', title: 'Whose problem is it?', text: 'The vendor’s contract caps their liability at one month’s fees. Does your cyber policy cover an AI tool going wrong?', tests: ['i_call'], choices: [
          c('a', 'Call the insurer’s breach line now, give them the facts and ask what they need', 'They open a claim and tell you what to keep. The cover question is theirs to answer, not a guess.', 'a5', { i_call: 2 }),
          c('b', 'Read the policy wording next week', 'Many policies want prompt notice.', 'a5'),
          c('c', 'Threaten the vendor with a lawsuit first', 'It feels good for an hour.', 'a4b'),
        ] },
        { id: 'a4b', at: 240, to: 'owner', title: 'The vendor’s lawyer', text: 'The vendor replies with their lawyer copied. They want your logs. Your own lawyer hasn’t seen anything yet.', tests: ['r_counsel', 'e_preserve'], choices: [
          c('a', 'Pause. Let your lawyer handle the vendor, and share logs only through counsel', 'The conversation slows down, which is what you need.', 'a5', { r_counsel: 2, e_preserve: 1 }),
          c('b', 'Send them everything to prove it was their bug', 'Your only copy of what happened is now in their hands, unannotated.', 'a5'),
          c('c', 'Stop replying', 'Calmer, but nobody is handling it.', 'a5', { r_counsel: 1 }),
        ] },
        { id: 'a5', at: 300, to: 'comms', title: 'Eighteen people', text: 'The eighteen affected customers need to hear from a person, not a bot.', tests: ['p_customers', 'p_staff'], choices: [
          c('a', 'A person writes to each one: what was shared, what you’ve done, a direct contact - and support gets the same short script', 'Two reply angry, sixteen reply “thanks for being straight”.', 'a6', { p_customers: 2, p_staff: 1 }),
          c('b', 'Let the AI draft a mass apology and send it', 'One customer replies: “You used the robot to apologise for the robot?”', 'a6'),
          c('c', 'Call the three biggest customers only', 'The other fifteen find out from each other.', 'a6', { p_customers: 1 }),
        ] },
        { id: 'a6', at: 2880, to: 'ops', title: 'Turn it back on?', text: 'Thursday. The team wants the agent back - it was handling 40% of tickets.', tests: ['c_killswitch', 'e_log'], choices: [
          c('a', 'Bring it back with limits: one customer’s ticket at a time, a person approving outbound email for two weeks, logs kept, and a named person who can switch it off', 'It handles 30% of tickets with a person watching, and you’ll know within minutes if it slips.', 'end', { c_killswitch: 2, e_log: 1 }),
          c('b', 'Turn it back on as it was - the vendor says it’s patched', 'You are trusting a sentence in an email.', 'end'),
          c('c', 'Never use AI again', 'Safe, and the 40% lands back on the team.', 'end', { c_killswitch: 1 }),
        ] },
      ],
    },
    {
      id: 'bec',
      title: 'The payroll email that wasn’t from the CEO',
      emoji: '💸',
      blurb: 'An urgent wire request from the boss at 4:20 on a Friday. The address looks right. The bank closes at five.',
      start: { day: 4, time: '16:20' },
      minutes: 35,
      injects: [
        { id: 'b1', at: 0, to: 'finance', title: 'Urgent, from the CEO', text: 'An email from the CEO: “Boarding a flight. Urgent - the new supplier needs $48,500 today or we lose the contract. Bank details attached. Don’t call, I’m offline.” The address looks right.', tests: ['l_verify'], choices: [
          c('a', 'Call the CEO on the number you already have - not one from the email - before doing anything', 'Straight to voicemail. You text their assistant too, and wait.', 'b2', { l_verify: 2 }),
          c('b', 'Reply to the email to double-check', 'The reply goes to whoever sent it.', 'b1b'),
          c('c', 'Pay it - it’s the CEO, and it’s urgent', 'The money leaves at 4:31.', 'b3'),
        ] },
        { id: 'b1b', at: 15, to: 'finance', title: '“Yes, please hurry”', text: '“Yes, please hurry, I’m boarding,” comes the reply. Your manager is out. The bank’s cut-off is 5pm.', tests: ['l_verify', 'l_lead'], choices: [
          c('a', 'Don’t pay. Call the CEO’s known number, then their assistant, and tell your manager', 'The assistant answers: the CEO is on a plane - to a conference, not to a supplier.', 'b2', { l_verify: 2, l_lead: 1 }),
          c('b', 'Pay half now to show willing', 'Half is $24,250, and it is gone.', 'b3'),
          c('c', 'Pay it - you’ll be blamed if the contract is lost', 'The money leaves at 4:52.', 'b3'),
        ] },
        { id: 'b2', at: 30, to: 'owner', title: '“I never sent that”', text: 'The real CEO calls back from the airport: “I never sent that.” Someone is impersonating them - and they knew about the new supplier.', tests: ['l_lead', 'p_staff'], choices: [
          c('a', 'Take charge: tell finance and the assistant no payments on email instructions this weekend, and get IT to check the CEO’s mailbox', 'The door closes on round two, and IT starts looking for how they knew.', 'b4', { l_lead: 2, p_staff: 2 }),
          c('b', 'Laugh it off - we caught it', 'They will try again on Monday, and they still have a way in.', 'b4'),
          c('c', 'Send a company-wide warning from the CEO’s account', 'The attacker reads it too.', 'b4', { p_staff: 1 }),
        ] },
        { id: 'b3', at: 60, to: 'finance', title: '“What payment?”', text: 'The payment has gone. The real CEO lands and texts: “What payment?”', tests: ['c_money'], choices: [
          c('a', 'Call your bank’s fraud line now, ask them to recall the payment, and get a reference number', 'The bank flags it with the receiving bank within the hour. Recalls work best in the first hours.', 'b3b', { c_money: 2 }),
          c('b', 'Email the bank and wait for Monday', 'Monday is a long way off for money in motion.', 'b3b'),
          c('c', 'Email the “supplier” asking for it back', 'They don’t reply.', 'b3b'),
        ] },
        { id: 'b3b', at: 90, to: 'legal', title: 'Report it?', text: 'The bank has started a recall. They ask whether you’ve reported the crime.', tests: ['r_report', 'i_call'], choices: [
          c('a', 'Report it where you operate (for example the FBI’s IC3 in the US, or Action Fraud in the UK) and call the insurer', 'Both have a reference number by 6pm. Some policies cover this kind of fraud - if told promptly.', 'b4', { r_report: 2, i_call: 2 }),
          c('b', 'Too embarrassing - hope the bank sorts it out', 'The bank asks again on Monday. So does the insurer, eventually.', 'b4'),
          c('c', 'Report it next week when things calm down', 'Later is better than never - and worse than now.', 'b4', { r_report: 1 }),
        ] },
        { id: 'b4', at: 120, to: 'it', title: 'How did they know?', text: 'IT finds a rule in the CEO’s mailbox, created two weeks ago, forwarding every email containing “invoice” to an outside address.', tests: ['c_access', 'e_preserve'], choices: [
          c('a', 'Save the rule and the sign-in logs, then remove it, reset the password, sign out every session and turn on two-step sign-in', 'They are out, and you can show exactly how they got in and what they read.', 'b5', { c_access: 2, e_preserve: 2 }),
          c('b', 'Delete the rule and move on', 'The rule is gone. Their password still works.', 'b5', { c_access: 1 }),
          c('c', 'Leave it for Monday', 'They read the whole weekend’s mail.', 'b5'),
        ] },
        { id: 'b5', at: 4320, to: 'comms', title: 'It happened to the supplier too', text: 'Monday. A real supplier calls: they got an email “from you” changing your bank details for their payments to you.', tests: ['p_customers', 'l_verify'], choices: [
          c('a', 'Warn every supplier and customer you invoice: you will never change bank details by email, and they should call to confirm', 'Two more say they had the same email - and didn’t pay it.', 'b6', { p_customers: 2, l_verify: 1 }),
          c('b', 'Tell only that supplier', 'The ones who weren’t told are the ones who pay.', 'b6', { p_customers: 1 }),
          c('c', 'Say nothing - it’s their problem', 'It’s your name on the email.', 'b6'),
        ] },
        { id: 'b6', at: 7200, to: 'owner', title: 'The review', text: 'Wednesday. What changes?', tests: ['l_verify', 'e_log'], choices: [
          c('a', 'A rule: payments and bank changes confirmed by a call to a known number, two people approve over $5,000 - and write up the timeline', 'The next “urgent” email gets a phone call and goes nowhere.', 'end', { l_verify: 2, e_log: 2 }),
          c('b', 'Send everyone a phishing training video', 'Useful, but a video doesn’t stop a payment.', 'end', { l_verify: 1 }),
          c('c', 'Fire whoever nearly paid', 'Next time, nobody tells you they nearly paid.', 'end'),
        ] },
      ],
    },
    {
      id: 'outage',
      title: 'The website is down on launch day',
      emoji: '🚀',
      blurb: 'Launch is at ten, the email to 30,000 subscribers is scheduled, and the site says Error 502.',
      start: { day: 2, time: '09:00' },
      minutes: 35,
      injects: [
        { id: 'w1', at: 0, to: 'it', title: 'Error 502', text: 'Launch is at 10:00 and the email to 30,000 subscribers is scheduled. The website shows “Error 502”. The developer pushed a “small fix” at 8:45.', tests: ['v_rollback'], choices: [
          c('a', 'Roll back the 8:45 change first, ask questions after', 'The site is back at 9:08. Now you have time to find out what the fix broke.', 'w2', { v_rollback: 2 }),
          c('b', 'Ask the developer to fix it forward', 'Twenty minutes of “nearly there”.', 'w2', { v_rollback: 1 }),
          c('c', 'Restart the server and hope', 'It comes back for a minute, then 502 again.', 'w1b'),
        ] },
        { id: 'w1b', at: 25, to: 'ops', title: 'Still down', text: 'Still down. The hosting company’s status page says “all systems normal”. Three people are now trying things.', tests: ['l_lead', 'v_rollback'], choices: [
          c('a', 'Name one person to run it, roll back the 8:45 change, and open a ticket with the host in parallel', 'Back up at 9:35, and you know it was the change.', 'w2', { l_lead: 2, v_rollback: 2 }),
          c('b', 'Let everyone keep trying something', 'Three people change three things. Nobody knows what fixed what.', 'w2'),
          c('c', 'Wait for the host to respond', 'Their status page still says all systems normal.', 'w2'),
        ] },
        { id: 'w2', at: 40, to: 'comms', title: 'The email goes at ten', text: 'The launch email goes to 30,000 people at 10:00. Nobody has confirmed the site works yet.', tests: ['p_customers', 'v_trading'], choices: [
          c('a', 'Pause the scheduled email until the site is confirmed up, and tell the team the new time', 'It goes out at 10:40 to a working site.', 'w3', { p_customers: 2, v_trading: 1 }),
          c('b', 'Let it send - it’ll probably be fine', '30,000 people click at once.', 'w2b'),
          c('c', 'Cancel the launch entirely', 'Safe - but the press article goes live at 10:00 anyway.', 'w3', { p_customers: 1 }),
        ] },
        { id: 'w2b', at: 65, to: 'comms', title: '“lol launch”', text: 'Thousands of people just clicked through to an error page. Posts are appearing: “lol launch”.', tests: ['p_customers'], choices: [
          c('a', 'Post a short, human update with a new time, pin it, and reply to the top posts', 'By lunch the top reply is “respect for owning it”.', 'w3', { p_customers: 2 }),
          c('b', 'Delete the email campaign', 'It’s already in 30,000 inboxes.', 'w3'),
          c('c', 'Blame the hosting company publicly', 'And then it turns out it was your change.', 'w3'),
        ] },
        { id: 'w3', at: 90, to: 'finance', title: 'Charged, but no order', text: 'The site is back. But some checkouts failed after customers were charged.', tests: ['v_trading', 'p_customers'], choices: [
          c('a', 'Pull the list of charged-but-failed orders, refund or fulfil each one, and email those customers personally', 'Forty-one customers get an email before they notice. Most keep their order.', 'w4', { v_trading: 2, p_customers: 2 }),
          c('b', 'Wait for the payment provider’s report at month-end', 'Forty-one customers notice first.', 'w4'),
          c('c', 'Refund everyone who ordered today', 'Generous, and expensive.', 'w4', { v_trading: 1 }),
        ] },
        { id: 'w4', at: 150, to: 'it', title: 'Ten times the traffic', text: 'Traffic is ten times normal and the site is wobbling again.', tests: ['v_trading', 'e_log'], choices: [
          c('a', 'Switch on a lightweight launch page that keeps checkout working, and note every change and its time', 'Checkout holds all afternoon. You can say exactly what changed when.', 'w5', { v_trading: 2, e_log: 2 }),
          c('b', 'Buy a bigger hosting plan on the spot and restart', 'Ten minutes of downtime at peak. Then it holds.', 'w5', { v_trading: 1 }),
          c('c', 'Take the site down until traffic calms down', 'Traffic calms down. So do sales.', 'w5'),
        ] },
        { id: 'w5', at: 1440, to: 'owner', title: 'Was it an attack?', text: 'Thursday. A partner asks whether customer data is safe, and wants it in writing.', tests: ['e_log', 'l_lead'], choices: [
          c('a', 'Write a short incident summary from the timeline - what broke, why, the impact, the fixes - and check it’s accurate before it goes', 'The partner replies: “Clear. Thanks.”', 'w6', { e_log: 2, l_lead: 1 }),
          c('b', 'Say it was a hack, to save face', 'Now you’ve reported an attack that didn’t happen.', 'w6'),
          c('c', 'Ignore the question', 'The partner asks again, more formally.', 'w6'),
        ] },
        { id: 'w6', at: 2880, to: 'ops', title: 'The review', text: 'Friday. What changes before the next launch?', tests: ['v_rollback', 'l_lead'], choices: [
          c('a', 'No changes in the two hours before a launch, a one-step rollback, a named launch lead and a status page', 'Next launch, the only 502 is in the retro’s slides.', 'end', { v_rollback: 2, l_lead: 2 }),
          c('b', 'Move launches to the weekend', 'Same risk, fewer people around.', 'end'),
          c('c', 'Find out whose fault it was', 'The developer stops pushing fixes. And stops telling you things.', 'end'),
        ] },
      ],
    },
  ];
  const DEMO_ID = 'laptop';
  const scenarioById = (id) => SCENARIOS.find((s) => s.id === id) || null;

  /* ------------------------------------------------------------------ *
   * The one door for a scenario
   * ------------------------------------------------------------------ */

  const INJECT_ID_RE = /^[a-z][a-z0-9]{0,11}$/;
  const SCENARIO_ID_RE = /^[a-z][a-z0-9-]{1,23}$/;
  const EMOJI_SET = ['🔒', '📇', '🤖', '💸', '🚀', '🚆', '🔥', '🌊', '⚡', '🧯', '📦', '🛒', '🏥', '🏗️', '🍽️', '🧾', '📞', '🕵️', '🛰️', '🧪'];
  const CHOICE_IDS = ['a', 'b', 'c', 'd'];

  /**
   * Clean a scenario - built-in or from a model - into the canonical shape,
   * or say what is wrong with it. {scenario, problems}: scenario is null
   * whenever problems is not empty. Every rule here is one a built-in is
   * held to by the tests, so a custom scenario cannot be worse-formed than
   * the ones that ship.
   */
  function cleanScenario(raw, opts) {
    const o = opts || {};
    const min = o.minInjects || LIMITS.minInjects;
    const problems = [];
    const fail = (p) => { problems.push(p); return { scenario: null, problems }; };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Not a scenario.');
    const title = cleanText(raw.title, LIMITS.title);
    if (!title || Array.from(title).length < 4) problems.push('A title of 4 to 60 characters.');
    const blurb = cleanText(raw.blurb, LIMITS.blurb);
    if (!blurb) problems.push('A one-line description.');
    const emoji = EMOJI_SET.includes(raw.emoji) ? raw.emoji : '🧯';
    const startIn = raw.start && typeof raw.start === 'object' ? raw.start : {};
    const day = Number.isInteger(startIn.day) && startIn.day >= 0 && startIn.day <= 6 ? startIn.day : 0;
    const time = typeof startIn.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(startIn.time) ? startIn.time : '09:00';
    const list = Array.isArray(raw.injects) ? raw.injects.slice(0, LIMITS.maxInjects + 1) : [];
    if (list.length < min || list.length > LIMITS.maxInjects) return fail(`Between ${min} and ${LIMITS.maxInjects} injects.`);
    const ids = new Set();
    const injects = [];
    list.forEach((ri, n) => {
      const where = `Inject ${n + 1}`;
      if (!ri || typeof ri !== 'object') { problems.push(`${where}: not an inject.`); return; }
      const id = typeof ri.id === 'string' && INJECT_ID_RE.test(ri.id) ? ri.id : null;
      if (!id || ids.has(id) || id === 'end') { problems.push(`${where}: a unique short id.`); return; }
      ids.add(id);
      const at = Number(ri.at);
      if (!Number.isInteger(at) || at < 0 || at > LIMITS.maxAt) problems.push(`${where}: a time in whole minutes from the start.`);
      const to = ROLE_IDS.includes(ri.to) ? ri.to : null;
      if (!to) problems.push(`${where}: addressed to a known role.`);
      const ititle = cleanText(ri.title, LIMITS.injectTitle);
      const text = cleanText(ri.text, LIMITS.injectText);
      if (!ititle) problems.push(`${where}: a title.`);
      if (!text || text.length < 20) problems.push(`${where}: say what happens.`);
      const tests = Array.isArray(ri.tests) ? [...new Set(ri.tests.filter((t) => typeof t === 'string' && own(ITEMS, t)))] : [];
      if (!tests.length || tests.length > LIMITS.maxTests) problems.push(`${where}: test 1 to ${LIMITS.maxTests} checklist items.`);
      const rc = Array.isArray(ri.choices) ? ri.choices.slice(0, LIMITS.maxChoices + 1) : [];
      if (rc.length < LIMITS.minChoices || rc.length > LIMITS.maxChoices) problems.push(`${where}: ${LIMITS.minChoices} to ${LIMITS.maxChoices} choices.`);
      const seen = new Set();
      const choices = rc.slice(0, LIMITS.maxChoices).map((ch, k) => {
        const cw = `${where}, choice ${k + 1}`;
        const ctext = ch && typeof ch === 'object' ? cleanText(ch.text, LIMITS.choiceText) : '';
        const then = ch && typeof ch === 'object' ? cleanText(ch.then, LIMITS.thenText) : '';
        if (!ctext) problems.push(`${cw}: what the team does.`);
        else if (seen.has(fold(ctext))) problems.push(`${cw}: the same as another choice.`);
        seen.add(fold(ctext));
        if (!then) problems.push(`${cw}: a consequence.`);
        const next = ch && typeof ch.next === 'string' ? ch.next : '';
        const hits = {};
        const rh = ch && ch.hits;
        const pairs = Array.isArray(rh) ? rh.map((h) => [h && h.item, h && h.points]) : (rh && typeof rh === 'object' ? Object.keys(rh).map((k2) => [k2, rh[k2]]) : []);
        for (const [item, pts] of pairs) {
          if (typeof item !== 'string' || !tests.includes(item)) continue;
          const p = Number(pts);
          if (p === 1 || p === 2) hits[item] = p;
        }
        return { id: CHOICE_IDS[k], text: ctext, then, next, hits };
      });
      if (choices.length && !choices.some((ch) => Object.values(ch.hits).includes(2))) problems.push(`${where}: at least one choice that gets something fully right.`);
      if (choices.length && choices.every((ch) => tests.every((t) => ch.hits[t] === 2))) problems.push(`${where}: at least one choice that misses something.`);
      injects.push({ id, at, to, title: ititle, text, tests, choices });
    });
    if (problems.length) return { scenario: null, problems };
    const byId = {};
    injects.forEach((i) => { byId[i.id] = i; });
    for (const inj of injects) {
      for (const ch of inj.choices) {
        if (ch.next === 'end') continue;
        const to = byId[ch.next];
        if (!to) problems.push(`${inj.id}: a choice goes to an inject that does not exist.`);
        else if (!(to.at > inj.at)) problems.push(`${inj.id}: a choice goes back in time (to ${to.id}).`);
      }
    }
    if (injects.length && injects[0].at !== 0) problems.push('The first inject starts at minute 0.');
    if (problems.length) return { scenario: null, problems };
    const reach = new Set();
    const stack = [injects[0].id];
    while (stack.length) {
      const id = stack.pop();
      if (reach.has(id)) continue;
      reach.add(id);
      byId[id].choices.forEach((ch) => { if (ch.next !== 'end') stack.push(ch.next); });
    }
    injects.forEach((i) => { if (!reach.has(i.id)) problems.push(`${i.id}: nothing leads to it.`); });
    if (!injects.some((i) => i.choices.some((ch) => ch.next === 'end'))) problems.push('Nothing ends the scenario.');
    if (problems.length) return { scenario: null, problems };
    const id = typeof raw.id === 'string' && SCENARIO_ID_RE.test(raw.id) ? raw.id : 'custom';
    const out = { id, title, emoji, blurb, start: { day, time }, minutes: Math.max(5, Math.min(120, Number.isInteger(raw.minutes) ? raw.minutes : injects.length * 5)), injects };
    if (raw.demo === true) out.demo = true;
    if (raw.custom === true) out.custom = true;
    return { scenario: out, problems: [] };
  }

  function injectOf(scn, id) {
    return (scn && scn.injects || []).find((i) => i.id === id) || null;
  }
  function choiceOf(inj, id) {
    return (inj && inj.choices || []).find((ch) => ch.id === id) || null;
  }
  /** Every path from the first inject to an end, as lists of inject ids.
   *  Graphs are small and acyclic (time only moves forward). */
  function paths(scn, cap) {
    const out = [];
    const max = cap || 2000;
    const walk = (id, trail) => {
      if (out.length >= max) return;
      const inj = injectOf(scn, id);
      const t = trail.concat(id);
      const nexts = [...new Set(inj.choices.map((ch) => ch.next))];
      for (const n of nexts) {
        if (n === 'end') out.push(t);
        else walk(n, t);
      }
    };
    if (scn && scn.injects && scn.injects.length) walk(scn.injects[0].id, []);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The clock
   * ------------------------------------------------------------------ */

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function sinceLabel(min) {
    const m = Math.max(0, Math.floor(Number(min) || 0));
    if (m === 0) return 'The start';
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} in`;
    if (m < 1440) {
      const h = Math.floor(m / 60);
      const r = m % 60;
      return `${h} hour${h === 1 ? '' : 's'}${r ? ` ${r} min` : ''} in`;
    }
    const d = Math.floor(m / 1440);
    return `${d} day${d === 1 ? '' : 's'} in`;
  }
  function wallLabel(scn, at) {
    const [hh, mm] = String(scn.start && scn.start.time || '09:00').split(':').map(Number);
    const total = hh * 60 + mm + Math.max(0, Math.floor(Number(at) || 0));
    const day = DAYS[(((scn.start && scn.start.day) || 0) + Math.floor(total / 1440)) % 7];
    const t = total % 1440;
    const h = Math.floor(t / 60);
    const ap = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${day} ${h12}:${String(t % 60).padStart(2, '0')} ${ap}`;
  }
  function clock(scn, at) { return { wall: wallLabel(scn, at), since: sinceLabel(at) }; }

  /* ------------------------------------------------------------------ *
   * Playing: what a choice does, what a room's votes decide
   * ------------------------------------------------------------------ */

  /** What one choice did: the consequence, and each tested item scored. */
  function outcome(inj, choiceId) {
    const ch = choiceOf(inj, choiceId);
    if (!ch) return null;
    return {
      choice: ch.id,
      text: ch.text,
      then: ch.then,
      next: ch.next,
      tested: inj.tests.map((t) => ({ id: t, label: ITEMS[t].label, area: ITEMS[t].area, points: ch.hits[t] || 0, of: 2 })),
    };
  }
  const total = (ch) => Object.values(ch.hits || {}).reduce((s, p) => s + p, 0);
  /** The choice that does least - what happens when the clock runs out and
   *  nobody voted: the team froze. Ties go to the first. */
  function worstChoice(inj) {
    let best = null;
    for (const ch of inj.choices) if (!best || total(ch) < total(best)) best = ch;
    return best ? best.id : null;
  }
  /** Votes {personId: choiceId} -> counts per choice, in choice order. */
  function tally(inj, votes) {
    const out = {};
    inj.choices.forEach((ch) => { out[ch.id] = 0; });
    Object.keys(votes || {}).forEach((p) => { const v = votes[p]; if (own(out, v)) out[v] += 1; });
    return out;
  }
  /** The leading choice; a tie goes to the first listed; no votes, the
   *  team froze (worstChoice). */
  function leading(inj, votes) {
    const t = tally(inj, votes);
    let best = null;
    inj.choices.forEach((ch) => { if (t[ch.id] > 0 && (best === null || t[ch.id] > t[best])) best = ch.id; });
    return best || worstChoice(inj);
  }
  /** Where a decision leads: the next inject id, or 'end'. */
  function nextOf(scn, injectId, choiceId) {
    const ch = choiceOf(injectOf(scn, injectId), choiceId);
    return ch ? ch.next : 'end';
  }
  /** A decision list must be a real walk through the scenario: it starts at
   *  the first inject and each one follows from the last. Returns the
   *  cleaned list (stopping at the first one that doesn't follow). */
  function cleanDecisions(scn, list) {
    const out = [];
    let at = scn.injects[0].id;
    for (const d of Array.isArray(list) ? list.slice(0, LIMITS.maxInjects) : []) {
      if (!d || d.inject !== at || at === 'end') break;
      const ch = choiceOf(injectOf(scn, at), d.choice);
      if (!ch) break;
      out.push({ inject: at, choice: ch.id, by: ['facilitator', 'timer', 'solo'].includes(d.by) ? d.by : 'solo', votes: d.votes && typeof d.votes === 'object' ? Object.keys(d.votes).reduce((s, k) => (CHOICE_IDS.includes(k) && Number.isInteger(d.votes[k]) && d.votes[k] >= 0 && d.votes[k] <= LIMITS.people ? Object.assign(s, { [k]: d.votes[k] }) : s), {}) : {}, late: d.late === true });
      at = ch.next;
    }
    return out;
  }
  function finished(scn, decisions) {
    if (!decisions.length) return false;
    const last = decisions[decisions.length - 1];
    return nextOf(scn, last.inject, last.choice) === 'end';
  }

  /* ------------------------------------------------------------------ *
   * The score and the after-action report
   * ------------------------------------------------------------------ */

  function bandOf(pct) {
    if (pct === null || pct === undefined) return { id: 'none', label: 'Not tested' };
    if (pct >= 80) return { id: 'ready', label: 'Ready' };
    if (pct >= 50) return { id: 'partly', label: 'Partly ready' };
    return { id: 'gap', label: 'Gap' };
  }
  /** Per item and per area: points earned of points possible. */
  function score(scn, decisions) {
    const items = {};
    for (const d of decisions) {
      const inj = injectOf(scn, d.inject);
      const ch = choiceOf(inj, d.choice);
      if (!inj || !ch) continue;
      for (const t of inj.tests) {
        if (!items[t]) items[t] = { id: t, earned: 0, possible: 0 };
        items[t].possible += 2;
        items[t].earned += ch.hits[t] || 0;
      }
    }
    const areas = AREAS.map((a) => {
      const its = Object.values(items).filter((it) => ITEMS[it.id].area === a.id);
      const earned = its.reduce((s, it) => s + it.earned, 0);
      const possible = its.reduce((s, it) => s + it.possible, 0);
      const pct = possible ? Math.round((100 * earned) / possible) : null;
      return { id: a.id, label: a.label, blurb: a.blurb, earned, possible, pct, band: bandOf(pct) };
    });
    const earned = areas.reduce((s, a) => s + a.earned, 0);
    const possible = areas.reduce((s, a) => s + a.possible, 0);
    const pct = possible ? Math.round((100 * earned) / possible) : 0;
    return { items, areas, earned, possible, pct, band: bandOf(possible ? pct : null) };
  }

  const AREA_ORDER = (id) => AREA_IDS.indexOf(ITEMS[id].area);
  /**
   * The after-action report as data. `meta`: {mode: 'solo'|'room', date
   * (YYYY-MM-DD), org (optional), people: [{name, role}]}. Nothing about
   * the business is needed; `org` only fills the heading if it was typed.
   */
  function report(scn, decisionsIn, meta) {
    const m = meta || {};
    const decisions = cleanDecisions(scn, decisionsIn);
    const s = score(scn, decisions);
    const rated = Object.values(s.items).map((it) => ({ ...it, ratio: it.possible ? it.earned / it.possible : 0 }));
    const went = rated.filter((it) => it.ratio >= 0.75)
      .sort((a, b) => b.ratio - a.ratio || b.possible - a.possible || AREA_ORDER(a.id) - AREA_ORDER(b.id))
      .slice(0, 3).map((it) => ({ id: it.id, label: ITEMS[it.id].label, text: ITEMS[it.id].good }));
    const weak = rated.filter((it) => it.ratio < 0.75)
      .sort((a, b) => a.ratio - b.ratio || b.possible - a.possible || AREA_ORDER(a.id) - AREA_ORDER(b.id));
    const gaps = weak.slice(0, 3).map((it) => ({ id: it.id, label: ITEMS[it.id].label, fix: ITEMS[it.id].fix, owner: ITEMS[it.id].owner, ownerLabel: roleOf(ITEMS[it.id].owner).label, pct: Math.round(100 * it.ratio) }));
    const actions = weak.slice(0, 5).map((it) => ({ text: ITEMS[it.id].fix, owner: ITEMS[it.id].owner, ownerLabel: roleOf(ITEMS[it.id].owner).label }));
    actions.push({ text: 'Run the next drill in three months - a different scenario, the same team.', owner: 'owner', ownerLabel: 'Owner' });
    const timeline = decisions.map((d) => {
      const inj = injectOf(scn, d.inject);
      const oc = outcome(inj, d.choice);
      const k = clock(scn, inj.at);
      const votes = Object.values(d.votes || {}).reduce((x, y) => x + y, 0);
      return {
        inject: inj.id, at: inj.at, wall: k.wall, since: k.since, to: inj.to, toLabel: roleOf(inj.to).label,
        title: inj.title, text: inj.text, choice: oc.text, then: oc.then, by: d.by, votes, late: Boolean(d.late),
        points: oc.tested.reduce((x, t) => x + t.points, 0), of: oc.tested.length * 2, tested: oc.tested,
      };
    });
    const people = Array.isArray(m.people) ? m.people.slice(0, LIMITS.people).map((p) => ({ name: cleanName(p && p.name) || 'Someone', role: (roleOf(p && p.role) || ROLES[0]).label })) : [];
    return {
      scenario: { id: scn.id, title: scn.title, emoji: scn.emoji, custom: Boolean(scn.custom) },
      mode: m.mode === 'room' ? 'room' : 'solo',
      date: typeof m.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.date) ? m.date : '',
      org: cleanOrg(m.org),
      complete: finished(scn, decisions),
      score: s.pct, band: s.band, areas: s.areas,
      went, gaps, actions, timeline, people,
      decisions: decisions.length,
    };
  }

  const NOT_ADVICE = 'A rehearsal, not legal advice. Breach-notice and reporting rules differ by country, state and industry - check the rules where you operate with your own counsel.';

  function mdEsc(s) { return String(s == null ? '' : s).replace(/([\\`*_[\]#|<>])/g, '\\$1'); }
  /** The report as Markdown, for a doc, a ticket or an email. */
  function reportMarkdown(r) {
    const L = [];
    L.push(`# After-action report: ${mdEsc(r.scenario.title)}`);
    L.push('');
    const who = [r.org ? mdEsc(r.org) : '', r.date, r.mode === 'room' ? 'team drill' : 'solo drill', r.complete ? '' : 'stopped early'].filter(Boolean).join(' · ');
    L.push(`*${who}*`);
    L.push('');
    L.push(`**Readiness: ${r.score}/100 - ${r.band.label}**`);
    L.push('');
    L.push('| Area | Score | |');
    L.push('|---|---|---|');
    r.areas.forEach((a) => L.push(`| ${mdEsc(a.label)} | ${a.pct === null ? '-' : `${a.pct}%`} | ${a.band.label} |`));
    L.push('');
    if (r.people.length) {
      L.push('## Who took part');
      L.push('');
      r.people.forEach((p) => L.push(`- ${mdEsc(p.name)} (${mdEsc(p.role)})`));
      L.push('');
    }
    L.push('## What went well');
    L.push('');
    if (r.went.length) r.went.forEach((w) => L.push(`- **${mdEsc(w.label)}.** ${mdEsc(w.text)}`));
    else L.push('- Nothing scored full marks this time. That is what a drill is for.');
    L.push('');
    L.push('## The three gaps to fix');
    L.push('');
    if (r.gaps.length) r.gaps.forEach((g, i) => L.push(`${i + 1}. **${mdEsc(g.label)}** - ${mdEsc(g.fix)} *(Owner: ${mdEsc(g.ownerLabel)})*`));
    else L.push('No gaps in this run. Try a harder scenario.');
    L.push('');
    L.push('## Action list');
    L.push('');
    L.push('| Action | Owner | Done |');
    L.push('|---|---|---|');
    r.actions.forEach((a) => L.push(`| ${mdEsc(a.text)} | ${mdEsc(a.ownerLabel)} | ☐ |`));
    L.push('');
    L.push('## Timeline of decisions');
    L.push('');
    r.timeline.forEach((t) => {
      L.push(`### ${mdEsc(t.wall)} (${mdEsc(t.since)}) - ${mdEsc(t.title)} - to ${mdEsc(t.toLabel)}`);
      L.push('');
      L.push(mdEsc(t.text));
      L.push('');
      L.push(`**Decided${t.by === 'timer' ? ' (the clock ran out)' : ''}:** ${mdEsc(t.choice)}${t.votes ? ` *(${t.votes} vote${t.votes === 1 ? '' : 's'})*` : ''}`);
      L.push('');
      L.push(`**What happened:** ${mdEsc(t.then)}`);
      L.push('');
      L.push(`Tested: ${t.tested.map((x) => `${mdEsc(x.label)} ${x.points}/2`).join(', ')}`);
      L.push('');
    });
    L.push('---');
    L.push('');
    L.push(`*Made with Drill. ${NOT_ADVICE}*`);
    return L.join('\n') + '\n';
  }

  function hEsc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  /** The report as one printable HTML page, every value escaped; no script. */
  function reportHtml(r) {
    const band = (b) => `<span class="b ${hEsc(b.id)}">${hEsc(b.label)}</span>`;
    const rows = r.areas.map((a) => `<tr><td>${hEsc(a.label)}</td><td>${a.pct === null ? '–' : `${a.pct}%`}</td><td>${band(a.band)}</td></tr>`).join('');
    const went = r.went.length ? r.went.map((w) => `<li><b>${hEsc(w.label)}.</b> ${hEsc(w.text)}</li>`).join('') : '<li>Nothing scored full marks this time. That is what a drill is for.</li>';
    const gaps = r.gaps.length ? r.gaps.map((g) => `<li><b>${hEsc(g.label)}</b> - ${hEsc(g.fix)} <i>(Owner: ${hEsc(g.ownerLabel)})</i></li>`).join('') : '<li>No gaps in this run. Try a harder scenario.</li>';
    const acts = r.actions.map((a) => `<tr><td>${hEsc(a.text)}</td><td>${hEsc(a.ownerLabel)}</td><td class="box">☐</td></tr>`).join('');
    const tl = r.timeline.map((t) => `<li><p class="when">${hEsc(t.wall)} · ${hEsc(t.since)} · to ${hEsc(t.toLabel)}</p><h3>${hEsc(t.title)}</h3><p>${hEsc(t.text)}</p><p><b>Decided${t.by === 'timer' ? ' (the clock ran out)' : ''}:</b> ${hEsc(t.choice)}${t.votes ? ` <i>(${t.votes} vote${t.votes === 1 ? '' : 's'})</i>` : ''}</p><p><b>What happened:</b> ${hEsc(t.then)}</p><p class="when">Tested: ${t.tested.map((x) => `${hEsc(x.label)} ${x.points}/2`).join(' · ')}</p></li>`).join('');
    const people = r.people.length ? `<h2>Who took part</h2><p>${r.people.map((p) => `${hEsc(p.name)} (${hEsc(p.role)})`).join(', ')}</p>` : '';
    const sub = [r.org ? hEsc(r.org) : '', hEsc(r.date), r.mode === 'room' ? 'team drill' : 'solo drill', r.complete ? '' : 'stopped early'].filter(Boolean).join(' · ');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>After-action report - ${hEsc(r.scenario.title)}</title>
<style>
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1b1d22;background:#fff;max-width:780px;margin:32px auto;padding:0 20px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid #d5d8de;padding-bottom:4px}h3{font-size:15px;margin:2px 0 4px}
.sub{color:#4a4f59;margin:0 0 16px}.score{font-size:20px;font-weight:700;margin:12px 0}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e3e5e9;padding:6px 8px;text-align:left;vertical-align:top}
.b{font-weight:700}.b.ready{color:#17663a}.b.partly{color:#8a4b00}.b.gap{color:#b42318}.b.none{color:#4a4f59}
.when{color:#4a4f59;font-size:13px;margin:0}ol.tl{list-style:none;padding:0}ol.tl li{border-left:3px solid #d5d8de;padding:2px 0 8px 14px;margin:0 0 10px}
.box{font-size:18px;width:40px}.foot{margin-top:28px;color:#4a4f59;font-size:13px}
@media print{body{margin:0}h2{break-after:avoid}ol.tl li{break-inside:avoid}}
</style></head><body>
<h1>After-action report: ${hEsc(r.scenario.title)}</h1>
<p class="sub">${sub}</p>
<p class="score">Readiness: ${r.score}/100 - ${hEsc(r.band.label)}</p>
<table><thead><tr><th>Area</th><th>Score</th><th></th></tr></thead><tbody>${rows}</tbody></table>
${people}
<h2>What went well</h2><ul>${went}</ul>
<h2>The three gaps to fix</h2><ol>${gaps}</ol>
<h2>Action list</h2><table><thead><tr><th>Action</th><th>Owner</th><th>Done</th></tr></thead><tbody>${acts}</tbody></table>
<h2>Timeline of decisions</h2><ol class="tl">${tl}</ol>
<p class="foot">Made with Drill. ${hEsc(NOT_ADVICE)}</p>
</body></html>
`;
  }

  /** A filename-safe slug for downloads. */
  function slug(s) { return fold(s).replace(/\s+/g, '-').slice(0, 40) || 'drill'; }

  return {
    LIMITS, ROLES, ROLE_IDS, AREAS, AREA_IDS, ITEMS, ITEM_IDS, SCENARIOS, DEMO_ID, EMOJI_SET, CHOICE_IDS, NOT_ADVICE, DAYS,
    clean, cleanText, cleanName, cleanOrg, fold, roleOf, scenarioById, cleanScenario, injectOf, choiceOf, paths,
    sinceLabel, wallLabel, clock, outcome, worstChoice, tally, leading, nextOf, cleanDecisions, finished,
    bandOf, score, report, reportMarkdown, reportHtml, slug,
  };
});
