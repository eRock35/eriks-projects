// The shared pieces behind receipts, card statements and trip photos
// (shared/receipts.js, statement.js, photostore.js). No server: these are the
// parts both trip apps lean on, tested once here.
const receipts = require('../shared/receipts.js');
const statement = require('../shared/statement.js');
const photostore = require('../shared/photostore.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const J = (v) => JSON.stringify(v);

(async () => {
  /* ---------------- statements: every big issuer's own layout ---------------- */
  const trip = { from: '2026-09-22', to: '2026-09-27' };

  // Chase: purchases NEGATIVE, a Type column, the bank's own category.
  const chase = [
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
    '09/26/2026,09/27/2026,SQ *THE DONUT HOLE SANTA ROSA FL,Food & Drink,Sale,-23.40,',
    '09/24/2026,09/25/2026,PUBLIX #1234 SANTA ROSA BEACH,Groceries,Sale,-187.12,',
    '09/23/2026,09/24/2026,SHELL OIL 57444,Gas,Sale,-61.03,',
    '09/25/2026,09/26/2026,PAYMENT THANK YOU,,Payment,1500.00,',
    '09/25/2026,09/26/2026,AMAZON MKTPL RETURN,Shopping,Return,19.99,',
    '09/10/2026,09/11/2026,NETFLIX.COM,Bills & Utilities,Sale,-15.49,',
  ].join('\r\n');
  let r = statement.parse(chase, trip);
  ok('Chase: reads the three trip purchases', r.transactions && r.transactions.length === 3, J(r));
  ok('...as positive spend, negatives flipped', r.transactions.every((t) => t.amount > 0) && r.transactions.some((t) => t.amount === 187.12));
  ok('...skipping the payment and the return', r.skipped.payments === 2, J(r.skipped));
  ok('...and Netflix, which is not on the trip', r.skipped.outOfRange === 1);
  ok('...using the transaction date, not the posting date', r.transactions.find((t) => t.amount === 23.4).date === '2026-09-26');
  ok('...categorised by the bank\'s own column', J(r.transactions.map((t) => t.kind).sort()) === J(['food', 'gas', 'groceries']), J(r.transactions.map((t) => t.kind)));
  ok('...with the card noise tidied off the name', r.transactions.find((t) => t.amount === 23.4).description === 'The Donut Hole Santa Rosa FL', r.transactions.find((t) => t.amount === 23.4).description);
  ok('...sorted by date', r.transactions[0].date === '2026-09-23');

  // Amex: purchases POSITIVE, credits negative, plain Date column.
  const amex = 'Date,Description,Amount\n09/24/2026,"HARBOR DOCKS DESTIN, FL",142.80\n09/25/2026,MARRIOTT COURTYARD,389.00\n09/25/2026,ONLINE PAYMENT - THANK YOU,-900.00\n09/26/2026,UBER *TRIP,18.22\n';
  r = statement.parse(amex, trip);
  ok('Amex: the positive sign is spending here', r.transactions.length === 3 && r.transactions.every((t) => t.amount > 0), J(r));
  ok('...a quoted description with a comma survives', r.transactions.some((t) => /Harbor Docks Destin, FL/i.test(t.description)), J(r.transactions.map((t) => t.description)));
  ok('...hotel and ride categorised by name', r.transactions.find((t) => t.amount === 389).kind === 'lodging' && r.transactions.find((t) => t.amount === 18.22).kind === 'transport');

  // Capital One: separate Debit and Credit columns.
  const capone = 'Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n2026-09-23,2026-09-24,1234,WAWA 8123,Gas/Automotive,48.10,\n2026-09-24,2026-09-25,1234,CAPITAL ONE MOBILE PYMT,Payment/Credit,,500.00\n2026-09-26,2026-09-27,1234,GULF PLACE CAFE,Dining,64.35,\n';
  r = statement.parse(capone, trip);
  ok('Capital One: debit and credit columns', r.transactions.length === 2 && r.skipped.payments === 1, J(r));
  ok('...categories from its own names', r.transactions.find((t) => t.amount === 48.1).kind === 'gas' && r.transactions.find((t) => t.amount === 64.35).kind === 'food');

  // Discover: "Trans. Date", positive spending.
  const discover = 'Trans. Date,Post Date,Description,Amount,Category\n09/25/2026,09/26/2026,SEASIDE MINI GOLF,32.00,Merchandise\n09/26/2026,09/27/2026,INTERNET PAYMENT - THANK YOU,-200.00,Payments and Credits\n';
  r = statement.parse(discover, trip);
  ok('Discover: "Trans. Date" is found', r.transactions.length === 1 && r.transactions[0].date === '2026-09-25', J(r));
  ok('...and mini golf is an activity, though Discover calls it Merchandise', r.transactions[0].kind === 'activities', r.transactions[0].kind);
  ok('a specific bank category still wins over the name', statement.kindOf('SEASIDE MINI GOLF', 'Dining') === 'food');

  // Bank of America: "Posted Date", Payee, negative purchases.
  const boa = 'Posted Date,Reference Number,Payee,Address,Amount\n09/24/2026,2469,GRAYTON BEER GARDEN,SANTA ROSA BEACH FL,-51.20\n09/25/2026,2470,BA ELECTRONIC PAYMENT,,300.00\n';
  r = statement.parse(boa, trip);
  ok('Bank of America: Payee and negative purchases', r.transactions.length === 1 && r.transactions[0].amount === 51.2, J(r));

  // Wells Fargo: no header row at all.
  const wf = '"09/24/2026","-27.50","*","","SEASIDE SWEET SHOPPE"\n"09/25/2026","-14.00","*","","PARKMOBILE"\n"09/26/2026","250.00","*","","ONLINE TRANSFER"\n';
  r = statement.parse(wf, trip);
  ok('Wells Fargo: a file with no header is read by its shape', r.transactions && r.transactions.length === 2, J(r));
  ok('...and parking is transport, not Mobil gas', r.transactions && r.transactions.find((t) => t.amount === 14).kind === 'transport');
  ok('a seashell shop is not a Shell station', statement.kindOf('SEASHELL SHOP DESTIN', '') !== 'gas' && statement.kindOf('SHELL OIL 57444', '') === 'gas');

  // A few summary lines above the real header, as some banks do.
  r = statement.parse('Account,XXXX1234\nStatement period,Sep 2026\n\nDate,Description,Amount\n2026-09-24,ICE CREAM SHOP,-8.50\n2026-09-24,COFFEE,-4.00\n', trip);
  ok('the header is found below account summary lines', r.transactions && r.transactions.length === 2, J(r));

  ok('not a statement is said plainly', /does not look like a card statement/.test(statement.parse('hello,world\n1,2\n', trip).error || ''));
  ok('an empty file is said plainly', /empty/.test(statement.parse('   ', trip).error || ''));
  ok('a huge file is refused before it is parsed', /larger than/.test(statement.parse('x'.repeat(statement.MAX_BYTES + 10), trip).error || ''));

  r = statement.parse(chase, { from: null, to: null });
  ok('with no trip dates, everything counts', r.transactions.length === 4 && r.skipped.outOfRange === 0, J(r.skipped));
  ok('slack lets the drive-down gas stop the day before count', statement.parse('Date,Description,Amount\n2026-09-21,SHELL,-40\n', trip).transactions.length === 1);
  ok('...but not two days before', statement.parse('Date,Description,Amount\n2026-09-20,SHELL,-40\n', trip).transactions.length === 0);

  ok('dates: US slashes are month-first', statement.parseDate('09/03/2026') === '2026-09-03');
  ok('dates: two-digit years', statement.parseDate('9/3/26') === '2026-09-03');
  ok('dates: "Sep 12, 2026" and "12 Sep 2026"', statement.parseDate('Sep 12, 2026') === '2026-09-12' && statement.parseDate('12 Sep 2026') === '2026-09-12');
  ok('dates: impossible ones are refused', statement.parseDate('02/31/2026') === null);
  ok('amounts: parentheses mean negative', statement.signed('(12.00)') === -12 && statement.signed('$1,234.56') === 1234.56);

  const flagged = statement.markDuplicates([{ date: '2026-09-24', amount: 142.8 }, { date: '2026-09-24', amount: 9 }], [{ date: '2026-09-23', amount: 142.8 }]);
  ok('a charge matching a scanned receipt is flagged, not dropped', flagged.length === 2 && flagged[0].possibleDuplicate === true && !flagged[1].possibleDuplicate);
  ok('...but not when the dates are a week apart',
     !statement.markDuplicates([{ date: '2026-09-24', amount: 142.8 }], [{ date: '2026-09-15', amount: 142.8 }])[0].possibleDuplicate);

  /* ---------------- receipts ---------------- */
  const CATS = ['Food', 'Transport', 'Other'];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');
  let q = receipts.request({ categories: CATS, image: { mediaType: 'image/jpeg', data: jpeg }, context: 'Santa Rosa Beach, Sep 22-27' });
  ok('a receipt request carries the image to the model', q.params && q.params.messages[0].content[0].type === 'image' && q.params.messages[0].content[0].source.data === jpeg);
  ok('...forces the one tool, so the answer is a structure', q.params.tool_choice.name === 'record_receipt');
  ok('...offers only this app\'s categories', J(q.params.tools[0].input_schema.properties.category.enum) === J(CATS));
  ok('...and tells it the trip', /Santa Rosa Beach/.test(q.params.system));
  ok('a non-image is refused before any model call', /not a photo/.test(receipts.request({ categories: CATS, image: { mediaType: 'application/pdf', data: jpeg } }).error || ''));
  ok('an oversized image is refused too', /too large/.test(receipts.request({ categories: CATS, image: { mediaType: 'image/jpeg', data: 'A'.repeat(8 * 1024 * 1024) } }).error || ''));
  ok('a data: prefix is tolerated', !!receipts.request({ categories: CATS, image: { mediaType: 'image/jpeg', data: 'data:image/jpeg;base64,' + jpeg } }).params);

  const answer = (input) => ({ content: [{ type: 'tool_use', name: 'record_receipt', input }] });
  let got = receipts.read(answer({ readable: true, merchant: 'The Donut Hole <b>', total: 23.4, date: '2026-09-26', category: 'food', note: 'Breakfast for 4' }), CATS);
  ok('a good answer becomes a proposed line', got.receipt && got.receipt.total === 23.4 && got.receipt.date === '2026-09-26', J(got));
  ok('...category matched case-insensitively to the app\'s own', got.receipt.category === 'Food');
  ok('...markup stripped from what the model wrote', got.receipt.merchant === 'The Donut Hole b');
  ok('...currency defaults to USD', got.receipt.currency === 'USD');
  got = receipts.read(answer({ readable: true, merchant: 'X', total: 10, category: 'Spa' }), CATS);
  ok('an invented category falls back to the last one (Other)', got.receipt.category === 'Other');
  ok('an unreadable receipt says so', /Could not read a total/.test(receipts.read(answer({ readable: false }), CATS).error || ''));
  ok('a zero or negative total is not a total', !!receipts.read(answer({ readable: true, total: 0 }), CATS).error && !!receipts.read(answer({ readable: true, total: -4 }), CATS).error);
  ok('a date that is not a date is dropped, the line kept', receipts.read(answer({ readable: true, total: 5, date: '2026-02-31' }), CATS).receipt.date === null);
  ok('no tool call at all is an error, not a crash', !!receipts.read({ content: [{ type: 'text', text: 'hmm' }] }, CATS).error);

  /* ---------------- photo storage ---------------- */
  const calls = [];
  const objects = {};
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', auth: (opts.headers || {}).Authorization });
    const u = new URL(url);
    if (u.pathname.startsWith('/upload/')) { objects[u.searchParams.get('name')] = Buffer.from(opts.body); return new Response('{}', { status: 200 }); }
    const m = /\/o\/(.+)$/.exec(u.pathname);
    if (m && (opts.method || 'GET') === 'DELETE') { const k = decodeURIComponent(m[1]); if (!objects[k]) return new Response('', { status: 404 }); delete objects[k]; return new Response(null, { status: 204 }); }
    if (m) { const k = decodeURIComponent(m[1]); return objects[k] ? new Response(objects[k], { status: 200, headers: { 'content-type': 'image/jpeg' } }) : new Response('', { status: 404 }); }
    if (/\/o$/.test(u.pathname)) { const p = u.searchParams.get('prefix'); return new Response(J({ items: Object.keys(objects).filter((k) => k.startsWith(p)).map((name) => ({ name })) }), { status: 200 }); }
    return new Response('', { status: 400 });
  };
  const store = photostore.create({ bucket: () => 'test-bucket', fetchImpl: fakeFetch, token: async () => 'tok' });
  ok('storage is enabled by a bucket name', store.enabled() && !photostore.create({ bucket: () => '' }).enabled());
  await store.put('trips/t1/p1.jpg', Buffer.from('abc'));
  ok('upload names the object and carries the runtime token',
     calls[0].url.includes('/upload/storage/v1/b/test-bucket/o?uploadType=media&name=trips%2Ft1%2Fp1.jpg') && calls[0].auth === 'Bearer tok', J(calls[0]));
  const back = await store.get('trips/t1/p1.jpg');
  ok('...and reads back the same bytes', back && back.buffer.toString() === 'abc');
  ok('a missing photo is null, not an error', (await store.get('trips/t1/nope.jpg')) === null);
  await store.put('trips/t1/p2.jpg', Buffer.from('x')); await store.put('trips/t2/p1.jpg', Buffer.from('y'));
  ok('deleting a trip\'s photos takes that trip only', (await store.delPrefix('trips/t1/')) === 2 && Object.keys(objects).length === 1 && objects['trips/t2/p1.jpg']);
  ok('deleting something already gone is fine', await store.del('trips/t1/p1.jpg'));

  // Runtime credentials come from the metadata server, cached.
  let metaHits = 0;
  const viaMeta = photostore.create({ bucket: () => 'b', fetchImpl: async (url, opts) => {
    if (String(url).startsWith('http://metadata.google.internal/')) { metaHits++; ok('...asking with the Metadata-Flavor header', opts.headers['Metadata-Flavor'] === 'Google'); return new Response(J({ access_token: 'meta-tok', expires_in: 3600 }), { status: 200 }); }
    ok('the metadata token is what reaches Storage', opts.headers.Authorization === 'Bearer meta-tok');
    return new Response('', { status: 404 });
  } });
  await viaMeta.get('a'); await viaMeta.get('b');
  ok('...fetched once and reused', metaHits === 1, String(metaHits));

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  ok('a JPEG is recognised by its bytes', photostore.imageBuffer(jpeg).contentType === 'image/jpeg');
  ok('a PNG too', photostore.imageBuffer(png.toString('base64')).contentType === 'image/png');
  ok('a script claiming to be a photo is refused', /not a photo/.test(photostore.imageBuffer(Buffer.from('<script>alert(1)</script>').toString('base64')).error || ''));
  ok('an oversized photo is refused', /too large/.test(photostore.imageBuffer('A'.repeat(photostore.MAX_PHOTO_BYTES * 2)).error || ''));
  ok('taken-at keeps the camera\'s wall-clock time', photostore.takenAt('2026-09-24T18:32:05') === '2026-09-24T18:32:05');
  ok('...a bare date gets midday', photostore.takenAt('2026-09-24') === '2026-09-24T12:00:00');
  ok('...and nonsense is null', photostore.takenAt('yesterday') === null && photostore.takenAt('2026-13-01') === null);
  ok('captions are bounded and stripped', photostore.caption('<img onerror=x>' + 'a'.repeat(400)).length === 200 && !/[<>]/.test(photostore.caption('<b>')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
