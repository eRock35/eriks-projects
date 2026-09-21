// The uptime prober: two failures before it speaks, one word when it recovers,
// and silence otherwise. Silence is the common case, so it is the one that
// most needs a test - an alert that fires every 15 minutes gets muted.
const h = require('./harness.js');
h.install();
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.IDENTITY_DATABASE_ID = 'identity';

const uptime = require(require('path').join(__dirname, '..', 'lib', 'uptime.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };

// Stand in for the network: every target answers however `state` says.
let state = 'up';
global.fetch = async () => {
  if (state === 'down') throw new Error('connect ECONNREFUSED');
  if (state === 'gated') return { ok: false, status: 302 };
  return { ok: true, status: 200 };
};

(async () => {
  let r = await uptime.check();
  ok('all up: nothing to say', !uptime.compose(r), JSON.stringify(r.nowDown));
  ok('...and every target was probed', r.results.length === uptime.TARGETS.length);

  state = 'gated';
  r = await uptime.check();
  ok('a redirect to /login counts as healthy', r.results.every((x) => x.ok) && !uptime.compose(r));

  state = 'down';
  r = await uptime.check();
  ok('ONE failure is still silence (cold starts happen)', !uptime.compose(r), JSON.stringify(r.nowDown));

  r = await uptime.check();
  let mail = uptime.compose(r);
  ok('the second failure alerts', Boolean(mail) && r.nowDown.length === uptime.TARGETS.length, mail && mail.subject);
  ok('...and the subject says how many', /not answering/.test(mail.subject), mail.subject);
  ok('...and the body names the app and the reason', /Trip Planner/.test(mail.text) && /ECONNREFUSED/.test(mail.text));

  r = await uptime.check();
  ok('it does not alert again while still down', !uptime.compose(r), JSON.stringify(r.nowDown));

  state = 'up';
  r = await uptime.check();
  mail = uptime.compose(r);
  ok('recovery is reported once', Boolean(mail) && /back up/i.test(mail.subject), mail && mail.subject);

  r = await uptime.check();
  ok('...and then it goes quiet again', !uptime.compose(r));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
