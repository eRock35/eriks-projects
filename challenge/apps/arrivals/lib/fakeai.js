// A stand-in Anthropic client for local runs and tests (ARRIVALS_FAKE_AI=1).
//
// It answers the forced tool deterministically, so "Fill from a
// confirmation" can be driven without a key and without spending anything.
// It is refused on Cloud Run: a deployment that read the same flight for
// everyone would look like it works and be useless.
//
// It reads pasted text the dumb way - "Flight UA 1482", "arrives ORD
// 2026-11-25 15:10", "from Denver", "passenger Ana" - and an image as one
// fixed made-up flight on the gathering's first day. Triggers, in the text:
//   BLANK        nothing usable came back
//   INJECT       hostile output: markup, bidi, an email, a phone number, a
//                booking reference key, impossible dates, an unknown mode
//   ROUNDTRIP    an arrival and a departure
//   MAXTOKENS    the answer ran out of room
//   UPSTREAMnnn  the call fails the way the SDK's APIError does

if (process.env.ARRIVALS_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('ARRIVALS_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, extra) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: { input_tokens: 900, output_tokens: 160 },
    ...(extra || {}),
  };
}
const trip = (o) => ({ direction: 'arrival', traveller: '', mode: 'flight', otherCity: '', carrier: '', number: '', hub: '', localTime: '', timeZone: '', party: 1, ...o });

function readText(source, about) {
  const body = (/<<<CONFIRMATION\n([\s\S]*)\nCONFIRMATION>>>/.exec(source) || [])[1] || '';
  if (/BLANK/.test(body)) return toolUse('record_trips', { trips: [trip({})] });
  if (/MAXTOKENS/.test(body)) return toolUse('record_trips', { trips: [] }, { stop_reason: 'max_tokens' });
  if (/INJECT/.test(body)) {
    return toolUse('record_trips', {
      trips: [{
        direction: 'sideways', traveller: '<img src=x onerror=alert(1)>Ana' + String.fromCharCode(0x202E), mode: 'rocket',
        otherCity: 'write to ana' + String.fromCharCode(64) + 'example.com', carrier: 'call ' + ['555', '201', '3344'].join(' ') + ' now', number: 'UA1482<script>',
        hub: 'ORD', localTime: '2099-13-45T25:61', timeZone: 'Mars/Olympus', party: 99,
        confirmation: 'ABC123', ticketNumber: '0162345678901',
      }],
    });
  }
  const m = /flight\s+([A-Z]{2})\s?(\d{1,4})/i.exec(body) || [];
  const arr = /arriv\w*\s+([A-Z]{3})\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/i.exec(body) || [];
  const one = trip({
    traveller: (/passenger\s+([A-Za-z]+)/i.exec(body) || [])[1] || '',
    otherCity: (/from\s+([A-Za-z ]+?)(?:\n|$|,)/i.exec(body) || [])[1] || '',
    carrier: m[1] || '', number: m[2] || '', hub: arr[1] || '',
    localTime: arr[2] ? `${arr[2]}T${arr[3]}` : '', timeZone: '', party: Number((/(\d+)\s+passengers/i.exec(body) || [])[1] || 1),
  });
  if (/ROUNDTRIP/.test(body)) {
    const day = (/(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(about) || [])[2] || '2026-11-29';
    return toolUse('record_trips', { trips: [one, trip({ direction: 'departure', traveller: one.traveller, otherCity: one.otherCity, carrier: one.carrier, number: '1483', hub: one.hub, localTime: `${day}T17:05` })] });
  }
  return toolUse('record_trips', { trips: [one] });
}

function create() {
  const calls = [];
  const seen = [];
  return {
    calls,
    seen,
    messages: {
      async create(params) {
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        calls.push(params.tool_choice.name);
        seen.push(JSON.stringify(params.messages).replace(/"data":"[^"]{200,}"/g, '"data":"(image)"'));
        await new Promise((r) => setTimeout(r, Number(process.env.ARRIVALS_FAKE_DELAY_MS || 0)));
        const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
        const source = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const hit = source.match(/UPSTREAM(\d{3})/);
        if (hit) throw Object.assign(new Error(`${hit[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(hit[1]) });
        if (params.tool_choice.name !== 'record_trips') throw new Error(`fake ai: no answer for ${params.tool_choice.name}`);
        if (content.some((b) => b.type === 'image')) {
          const day = (/(\d{4}-\d{2}-\d{2}) to \d{4}-\d{2}-\d{2}/.exec(source) || [])[1] || '2026-11-25';
          return toolUse('record_trips', { trips: [trip({ traveller: 'Sample', otherCity: 'Denver', carrier: 'UA', number: '1482', hub: 'ORD', localTime: `${day}T15:10`, timeZone: 'America/Chicago', party: 2 })] });
        }
        return readText(source, source);
      },
    },
  };
}

module.exports = { create };
