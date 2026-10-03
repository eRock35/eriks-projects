// shared/get-app.js, the "Get the iPhone app" bar and list: who sees the bar,
// which links are drawn, and that nothing typed reaches the page as markup.
const assert = require('assert');
const ga = require('../shared/get-app.js');

let n = 0;
const ok = (name) => { n++; console.log('  PASS  ' + name); };

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
assert.strictEqual(ga.wantsBar(IPHONE), true); ok('an iPhone browser sees the bar');
assert.strictEqual(ga.wantsBar(IPHONE + ' StrongTechApp/trip'), false); ok('the iPhone app itself never does');
assert.strictEqual(ga.wantsBar('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), false);
assert.strictEqual(ga.wantsBar('Mozilla/5.0 (Linux; Android 15; Pixel 9)'), false);
assert.strictEqual(ga.wantsBar(''), false); ok('a computer, an Android phone or no user agent does not');

assert.strictEqual(ga.validLink('https://testflight.apple.com/join/AbCd1234'), true);
for (const bad of ['http://testflight.apple.com/join/AbCd1234', 'https://testflight.apple.com.evil.example/join/AbCd1234',
  'https://testflight.apple.com/join/AbCd1234?x=1', 'javascript:alert(1)', 'https://testflight.apple.com/join/', null, 42]) {
  assert.strictEqual(ga.validLink(bad), false, String(bad));
}
ok('only an exact https TestFlight public link counts');

assert.strictEqual(ga.clean('Trip‮Planner\u0000'), 'TripPlanner'); ok('control and direction-override characters are stripped');
assert.strictEqual(ga.clean('x'.repeat(200)).length, 80); ok('names are cut to length');

const store = (v) => ({ localStorage: { getItem: () => v } });
const now = Date.now();
assert.strictEqual(ga.dismissed(store(String(now - 864e5)), now), true);
assert.strictEqual(ga.dismissed(store(String(now - 31 * 864e5)), now), false);
assert.strictEqual(ga.dismissed(store(null), now), false);
assert.strictEqual(ga.dismissed({ get localStorage() { throw new Error('blocked'); } }, now), false);
ok('dismissing hides it for 30 days, and blocked storage just shows it');

// drawList with a tiny stand-in DOM: only valid links, all text as text.
function el(tag) {
  return { tag, children: [], attrs: {}, hidden: true, textContent: '', className: '', href: '', rel: '',
    appendChild(c) { this.children.push(c); return c; }, querySelector() { return null; },
    setAttribute(k, v) { this.attrs[k] = v; } };
}
const box = el('div');
const doc = { querySelector: (s) => (s === '#iphoneApps' ? box : null), createElement: el };
const drawn = ga.drawList(doc, '#iphoneApps', [
  { name: 'Trip Planner', url: 'https://testflight.apple.com/join/AbCd1234', blurb: 'Plan a trip.' },
  { name: '<img src=x onerror=alert(1)>', url: 'https://testflight.apple.com/join/ZzZz9999' },
  { name: 'Bad', url: 'https://evil.example/join/AbCd1234' },
  null,
]);
assert.strictEqual(drawn, 2);
assert.strictEqual(box.hidden, false);
assert.strictEqual(box.children[1].children[0].textContent, '<img src=x onerror=alert(1)>');
ok('the list draws only valid links, un-hides itself, and sets names as text');
const empty = el('div');
assert.strictEqual(ga.drawList({ querySelector: () => empty, createElement: el }, '#x', []), 0);
assert.strictEqual(empty.hidden, true); ok('with no links the list stays hidden');

console.log(`\n${n}/${n} passed`);
