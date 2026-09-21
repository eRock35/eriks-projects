// The weekly roundup: only what moved, only once a week, and quiet when
// nothing happened. Quiet is the common case, so it is what most needs
// testing - a weekly email that always arrives gets filtered.
const h = require('./harness.js');
h.install();
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.IDENTITY_DATABASE_ID = 'identity';

const digest = require(require('path').join(__dirname, '..', 'lib', 'digest.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();

const fr = h.bag('friction');
const tp = h.bag('trip-planner');
const id = h.bag('identity');
// The harness keeps subcollections in their own bag, not the parent database's.
const sub = h.bag('sub');

(async () => {
  // A problem found this week, one that came back, one long-settled, one passed.
  fr.set('signals/a', { title: 'New this week', summary: 'x', score: 8, seenCount: 1, status: 'new', firstSeenAt: ago(2), lastSeenAt: ago(2) });
  fr.set('signals/b', { title: 'Came back', summary: 'y', score: 7, seenCount: 4, status: 'new', firstSeenAt: ago(40), lastSeenAt: ago(1) });
  fr.set('signals/c', { title: 'Old and quiet', summary: 'z', score: 9, seenCount: 2, status: 'new', firstSeenAt: ago(40), lastSeenAt: ago(30) });
  fr.set('signals/d', { title: 'Passed on', summary: 'q', score: 10, seenCount: 5, status: 'passed', firstSeenAt: ago(2), lastSeenAt: ago(1) });

  let found = await digest.gather();
  ok('a problem found this week is new', found.friction.fresh.some((s) => s.title === 'New this week'));
  ok('an old one seen again this week came back', found.friction.returning.some((s) => s.title === 'Came back'));
  ok('one nobody has seen in a month is neither', !JSON.stringify(found.friction).includes('Old and quiet'));
  ok('a problem already passed on is left out', !JSON.stringify(found.friction).includes('Passed on'));

  const mail = digest.compose(found, 'https://example.com');
  ok('the subject counts what moved', /1 new/.test(mail.subject) && /1 recurring/.test(mail.subject), mail.subject);
  ok('the body names the problem', /New this week/.test(mail.text));

  // Watches: one that changed, one saying the same thing, one on a booked trip.
  tp.set('trips/t1', { name: 'Lisbon', status: 'planning' });
  sub.set('trips/t1/watches/w1', { label: 'Flights', lastCheckedAt: ago(1), lastResult: 'Down to $842',
    history: [{ result: 'Was $1,010' }, { result: 'Down to $842' }] });
  sub.set('trips/t1/watches/w2', { label: 'Hotel', lastCheckedAt: ago(1), lastResult: 'No change',
    history: [{ result: 'No change' }, { result: 'No change' }] });
  tp.set('trips/t2', { name: 'Booked already', status: 'locked' });
  sub.set('trips/t2/watches/w3', { label: 'Flights', lastCheckedAt: ago(1), lastResult: 'Anything',
    history: [{ result: 'a' }, { result: 'Anything' }] });

  found = await digest.gather();
  const labels = JSON.stringify(found.watches);
  ok('a watch whose answer changed is reported', /Down to \$842/.test(labels), labels.slice(0, 120));
  ok('one repeating itself is not news', !/No change/.test(labels));
  ok('a locked trip is not being shopped for', !/Booked already/.test(labels));

  // Cadence.
  id.set('control/weekly-digest', { lastSentAt: new Date().toISOString() });
  let due = await digest.runIfDue({});
  ok('it does not send twice in a week', due.sent === false && due.reason === 'not due', JSON.stringify(due));
  ok('...and says when it next will', Boolean(due.nextDueAt));

  id.set('control/weekly-digest', { lastSentAt: ago(9) });
  due = await digest.runIfDue({});
  ok('a week later it is due', due.due === true && due.found.count > 0, JSON.stringify(due).slice(0, 90));

  // A quiet week moves the clock rather than firing the moment something lands.
  fr.clear(); tp.clear(); sub.clear();
  id.set('control/weekly-digest', { lastSentAt: ago(9) });
  due = await digest.runIfDue({});
  ok('a quiet week sends nothing', due.sent === false && due.reason === 'nothing to report', JSON.stringify(due));
  const after = id.get('control/weekly-digest');
  ok('...but the clock still moves', Date.now() - Date.parse(after.lastSentAt) < 60000);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
