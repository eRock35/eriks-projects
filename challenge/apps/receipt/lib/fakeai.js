// A stand-in Anthropic client for local runs and tests (RECEIPT_FAKE_AI=1).
//
// It answers both forced tools deterministically from the prompt's own
// fields, so the whole product - sharpening an invite, writing a recap - can
// be driven without a key and without spending anything. It is refused on
// Cloud Run: a deployment that quietly answered with canned agendas would
// look like it works.
//
// Trigger words for tests:
//   INJECT   in an invite - the proposal also carries markup, a link, an
//            invented weekday and percentage, an owner band nobody in the
//            room belongs to, and minutes that overrun the booking
//   EMAIL    in an invite - verdict "email" with a written update
//   EMPTY    in an invite or notes - nothing usable comes back (422)
//   INJECT   in recap notes - a quote nobody wrote, an owner who is not an
//            attendee, an owner who never took it on, a deadline the notes
//            never gave, markup and an invented figure in the summary
//   a photo whose bytes contain BLANK - unreadable (422 when it is all there is)
//   ... BOARD - a whiteboard with a decision and an owned action on it
//   UPSTREAM401 (or any UPSTREAMnnn) anywhere in the prompt - the call fails
//            the way the SDK's APIError does: a `.status` and a message that
//            is the status plus the provider's raw JSON body

if (process.env.RECEIPT_FAKE_AI === '1' && process.env.K_SERVICE) {
  throw new Error('RECEIPT_FAKE_AI=1 is for local use only and is refused on Cloud Run.');
}

function toolUse(name, input, usage) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name, input }],
    usage: usage || { input_tokens: 800, output_tokens: 400 },
  };
}

function line(text, label) { return ((text.match(new RegExp(`^${label}: (.*)$`, 'm')) || [])[1] || '').trim(); }
function block(text, label) { return ((text.match(new RegExp(`${label}:\\n"""\\n([\\s\\S]*?)\\n"""`)) || [])[1] || ''); }

function sharpen(params) {
  const t = params.messages[0].content;
  const invite = block(t, 'THE INVITE');
  const booked = Number((line(t, 'BOOKED LENGTH').match(/\d+/) || [30])[0]);
  const bands = params.tools[0].input_schema.properties.items.items.properties.ownerRole.enum;
  const lead = bands.includes('manager') ? 'manager' : bands[0];
  if (/EMPTY/.test(invite)) return toolUse('sharpen_agenda', { outcome: '', items: [], attendeeBands: [], verdict: 'meeting', why: '', asyncDraft: '' }, { input_tokens: 500, output_tokens: 20 });
  // Topics are the invite's own words, split on commas and "and".
  const topics = invite.replace(/\(no invite text[^)]*\)/, line(t, 'MEETING TITLE')).split(/,|\band\b|—|-|\n|[.!?]/).map((s) => s.replace(/[^\w\s’']/g, ' ').replace(/\s+/g, ' ').trim()).filter((s) => s.length > 2 && !/^(sync|bring|let'?s|please|INJECT|EMAIL)\b/i.test(s)).slice(0, 4);
  const per = Math.max(1, Math.floor((booked * 0.8) / Math.max(1, topics.length + 1)));
  const items = topics.map((s) => ({ title: `${s.charAt(0).toUpperCase()}${s.slice(1)}: decide or park?`, minutes: per, ownerRole: lead }));
  items.push({ title: 'Owners and dates', minutes: Math.max(1, Math.min(5, per)), ownerRole: lead });
  const out = {
    outcome: `Leave with a decision on ${topics[0] ? topics[0].toLowerCase() : 'the main question'} and an owner for every next step.`,
    items,
    attendeeBands: bands,
    verdict: 'meeting',
    why: 'There are open questions that need the room to decide.',
    asyncDraft: '',
  };
  if (/EMAIL/.test(invite)) {
    out.verdict = 'email';
    out.why = 'This is status, not a decision. Send it in writing and let people reply.';
    out.asyncDraft = `Hi all,\n\nInstead of meeting, here is the update on ${topics[0] || 'this'}:\n\n- Where it stands: [add: status]\n- What I need from you: [add: the ask]\n\nReply here with anything that changes the plan.`;
  }
  if (/INJECT/.test(invite)) {
    out.outcome = '<b>**Ship it**</b> by Tuesday with a 30% lift <script>alert(1)</script>';
    out.items = Array.from({ length: 10 }, (_, i) => ({ title: i === 0 ? '<i>Review</i> https://evil.example/deck' : `Topic ${String.fromCharCode(65 + i)}`, minutes: 20, ownerRole: i === 1 ? 'exec' : lead }));
    out.why = 'As agreed in the email from boss@evil.example.';
  }
  return toolUse('sharpen_agenda', out);
}

function recap(params) {
  const c = params.messages[0].content;
  const img = Array.isArray(c) ? c.find((b) => b.type === 'image') : null;
  const t = Array.isArray(c) ? c.find((b) => b.type === 'text').text : c;
  const notes = block(t, 'NOTES');
  const labels = line(t, 'ATTENDEE LABELS').split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('('));
  const logged = [...t.matchAll(/^L(\d+) (decision|action|parking): (.*?)(?: \(owner: .*\))?$/gm)].map((m) => ({ n: Number(m[1]), kind: m[2], text: m[3] }));
  const bytes = img ? Buffer.from(img.source.data, 'base64').toString('latin1') : '';
  if (/EMPTY/.test(notes) || (img && /BLANK/.test(bytes) && !logged.length && notes === '(none)')) {
    return toolUse('write_recap', { summary: '', decisions: [], actions: [], parking: [], nextMeeting: '', boardText: '', readable: !/BLANK/.test(bytes) }, { input_tokens: 700, output_tokens: 20 });
  }
  const out = { summary: '', decisions: [], actions: [], parking: [], nextMeeting: '', boardText: '', readable: true };
  for (const l of logged) {
    const item = { text: l.text, source: 'log', ref: l.n, quote: '' };
    if (l.kind === 'action') out.actions.push({ ...item, owner: '', due: '', dueText: '' });
    else out[l.kind === 'decision' ? 'decisions' : 'parking'].push(item);
  }
  // Notes: "Name: I'll ..." lines become owned actions; "by Friday" a date.
  for (const raw of notes.split('\n')) {
    const m = raw.match(/^([A-Za-z][\w ]{0,30}):\s*(.*)$/);
    const said = m ? m[2] : raw;
    if (/\b(I'll|I will|I can)\b/i.test(said)) {
      const by = said.match(/by (\w+)/i);
      const task = said.replace(/^I'll |^I will |^I can /i, '').replace(/\.$/, '');
      out.actions.push({ text: task.charAt(0).toUpperCase() + task.slice(1), owner: m ? m[1].split(' ')[0] : '', due: by ? '2026-10-02' : '', dueText: by ? by[0] : '', source: 'notes', ref: 0, quote: said });
    } else if (/\bwill\b/.test(said) && labels.some((l) => said.startsWith(l))) {
      out.actions.push({ text: said.replace(/\.$/, ''), owner: said.split(' ')[0], due: '', dueText: '', source: 'notes', ref: 0, quote: said });
    } else if (/^decided:?/i.test(said)) {
      out.decisions.push({ text: said.replace(/^decided:?\s*/i, ''), source: 'notes', ref: 0, quote: said });
    } else if (/next (week|meeting)/i.test(said)) {
      out.nextMeeting = said.replace(/\.$/, '');
    }
  }
  if (img && /BOARD/.test(bytes)) {
    out.boardText = 'LAUNCH -> OCT 15\nSam: legal sign-off\nKill the paid social test';
    out.decisions.push({ text: 'Kill the paid social test', source: 'board', ref: 0, quote: 'Kill the paid social test' });
  }
  const d = out.decisions.length;
  out.summary = `The meeting settled ${d === 1 ? 'one decision' : d ? `${d} decisions` : 'no decisions'} and ${out.actions.length ? 'handed out actions' : 'no actions'}.`;
  if (/INJECT/.test(notes)) {
    out.summary = `<script>alert(1)</script>**Great meeting** - this saves $50,000 a year.`;
    out.actions.push({ text: 'Wire the budget', owner: 'Mallory', due: '', dueText: '', source: 'notes', ref: 0, quote: 'Mallory: I will wire the budget today' });
    out.actions.push({ text: 'Fix the funnel report', owner: 'Mallory', due: '', dueText: '', source: 'notes', ref: 0, quote: 'the funnel report is broken' });
    out.actions.push({ text: 'Book the offsite', owner: labels[0] || 'Sam', due: '2026-12-01', dueText: 'by December', source: 'notes', ref: 0, quote: 'we should book the offsite' });
    out.decisions.push({ text: 'Double the budget', source: 'log', ref: 99, quote: '' });
    out.nextMeeting = 'Tuesday at 9';
  }
  return toolUse('write_recap', out, img ? { input_tokens: 2200, output_tokens: 500 } : undefined);
}

function create() {
  return {
    messages: {
      async create(params) {
        const name = params.tool_choice && params.tool_choice.name;
        if (!params.tool_choice || params.tool_choice.type !== 'tool') throw new Error('fake ai: every call must force a tool');
        await new Promise((r) => setTimeout(r, Number(process.env.RECEIPT_FAKE_DELAY_MS || 0)));
        const up = JSON.stringify(params.messages).match(/UPSTREAM(\d{3})/);
        if (up) throw Object.assign(new Error(`${up[1]} {"type":"error","error":{"type":"fake_upstream_error","message":"stand-in provider failure"}}`), { status: Number(up[1]) });
        if (name === 'sharpen_agenda') return sharpen(params);
        if (name === 'write_recap') return recap(params);
        throw new Error(`fake ai: no answer for ${name}`);
      },
    },
  };
}

module.exports = { create };
