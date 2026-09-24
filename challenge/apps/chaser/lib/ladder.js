// The chase ladder's words: the facts a draft is written from, and the
// template fallback that needs no model.
//
// The fallback matters as much as the model. Chasing money is the job; a
// free user who has spent their credit still has invoices, and "you are out
// of credit, so you cannot ask to be paid" would be a strange thing for a
// money app to say. Templates are always there, cost nothing, and use the
// same facts and the same voice settings the model gets.

const B = require('./book');

/** The facts of one chase, in words. Everything a draft may say about money
 *  comes from here - the model is told to use these and nothing else. */
function factsFor(d, client, settings, today, { kind, includeFee } = {}) {
  const k = B.KINDS.includes(kind) ? kind : d.nextKind;
  const fee = includeFee ? B.lateFee(d, settings.lateFee, today) : null;
  const brokenList = (d.promises || []).filter((p) => p.date < today && (d.balanceCents > 0 || (d.paidAt && d.paidAt > p.date)));
  const broken = brokenList.length ? brokenList[brokenList.length - 1] : null;
  const last = (d.chases || []).length ? d.chases[d.chases.length - 1] : null;
  const name = (client && client.name) || 'there';
  const contact = (client && client.contactName) || '';
  return {
    kind: k,
    kindLabel: B.kindInfo(k).label,
    clientName: name,
    firstName: contact ? contact.split(/\s+/)[0] : name,
    number: d.number || 'your invoice',
    amount: B.fmtMoney(d.amountCents, d.currency),
    balance: B.fmtMoney(d.balanceCents, d.currency),
    paidSoFar: d.paidCents > 0 ? B.fmtMoney(d.paidCents, d.currency) : null,
    currency: d.currency,
    issued: B.fmtDay(d.issued),
    due: B.fmtDay(d.due),
    daysLate: Math.max(0, d.daysLate),
    brokenPromise: broken ? { date: B.fmtDay(broken.date, true), note: broken.note || '' } : null,
    brokenCount: brokenList.length,
    lastChase: last ? { kind: B.kindInfo(last.kind).label, day: B.fmtDay(last.at.slice(0, 10)) } : null,
    chasesSent: (d.chases || []).length,
    fee: fee && fee.applies ? { amount: B.fmtMoney(fee.cents, d.currency), rule: fee.rule, total: B.fmtMoney(d.balanceCents + fee.cents, d.currency) } : null,
    paymentLink: settings.paymentLink || '',
    paymentInstructions: settings.paymentInstructions || '',
    business: settings.businessName || '',
    yourName: settings.yourName || '',
    signOff: settings.signOff || 'Thanks,',
    tone: Number.isFinite(settings.tone) ? settings.tone : 35,
  };
}

function toneBand(t) { return t < 40 ? 0 : t < 70 ? 1 : 2; }
const pick = (arr, t) => arr[toneBand(t)];

function signature(f) {
  return [f.signOff, f.yourName, f.yourName && f.business ? f.business : (!f.yourName ? f.business : '')].filter(Boolean).join('\n');
}

function payLine(f) {
  if (f.paymentLink && f.paymentInstructions) return `You can pay here: ${f.paymentLink}\n${f.paymentInstructions}`;
  if (f.paymentLink) return `You can pay here: ${f.paymentLink}`;
  if (f.paymentInstructions) return f.paymentInstructions;
  return '';
}

function feeLine(f) {
  if (!f.fee) return '';
  return `As per our terms, a late fee of ${f.fee.amount} now applies (${f.fee.rule}), bringing the total to ${f.fee.total}.`;
}

function promiseLine(f) {
  if (!f.brokenPromise) return '';
  return `You'd mentioned it would be paid by ${f.brokenPromise.date}, but it hasn't come through yet.`;
}

function partLine(f) {
  return f.paidSoFar ? `Thank you for the ${f.paidSoFar} already paid - ${f.balance} is still outstanding.` : '';
}

const BODIES = {
  nudge: (f) => [
    pick([`Hi ${f.firstName},`, `Hi ${f.firstName},`, `Hello ${f.firstName},`], f.tone),
    pick([
      `Hope all is well! Just a friendly reminder that invoice ${f.number} for ${f.balance} was due on ${f.due}. It may simply have slipped through - it happens to all of us.`,
      `A quick reminder that invoice ${f.number} for ${f.balance} was due on ${f.due} and I haven't seen payment yet.`,
      `Invoice ${f.number} for ${f.balance} was due on ${f.due} and is now ${f.daysLate} day${f.daysLate === 1 ? '' : 's'} overdue.`,
    ], f.tone),
    promiseLine(f), partLine(f), payLine(f), feeLine(f),
    pick([`If it's already on its way, thank you and please ignore this.`, `If it's already been sent, thanks - please ignore this.`, `Please arrange payment this week, or let me know if there's a problem.`], f.tone),
  ],
  followup: (f) => [
    `Hi ${f.firstName},`,
    pick([
      `Following up on invoice ${f.number} for ${f.balance}, which was due on ${f.due}.${f.lastChase ? ` I sent a reminder on ${f.lastChase.day}` + ' and wanted to make sure it reached you.' : ''}`,
      `I'm following up on invoice ${f.number} for ${f.balance}, now ${f.daysLate} days past its ${f.due} due date.`,
      `Invoice ${f.number} for ${f.balance} is now ${f.daysLate} days overdue${f.lastChase ? `, and my reminder of ${f.lastChase.day} has gone unanswered` : ''}.`,
    ], f.tone),
    promiseLine(f), partLine(f),
    pick([`Could you let me know when I can expect payment? If anything is holding it up, just tell me and we'll sort it out.`, `Could you confirm a payment date? If there's an issue with the invoice, let me know and I'll fix it.`, `Please confirm by return when it will be paid.`], f.tone),
    payLine(f), feeLine(f),
  ],
  firm: (f) => [
    `Hi ${f.firstName},`,
    pick([
      `Invoice ${f.number} for ${f.balance} is now ${f.daysLate} days overdue, and I do need to get it settled.`,
      `Invoice ${f.number} for ${f.balance} is now ${f.daysLate} days overdue. I've reminded you ${f.chasesSent} time${f.chasesSent === 1 ? '' : 's'} and need this resolved.`,
      `Invoice ${f.number} for ${f.balance} is ${f.daysLate} days overdue despite ${f.chasesSent} reminder${f.chasesSent === 1 ? '' : 's'}.`,
    ], f.tone),
    promiseLine(f), partLine(f),
    pick([`Please pay it within the next 7 days, or give me a call if you need to talk it through.`, `Please make payment within 7 days. If you can't pay in full, reply and we can agree a plan.`, `Payment is required within 7 days of this message.`], f.tone),
    payLine(f), feeLine(f),
  ],
  final: (f) => [
    `Hi ${f.firstName},`,
    `This is a final notice for invoice ${f.number}: ${f.balance}, due on ${f.due} and now ${f.daysLate} days overdue.`,
    promiseLine(f), partLine(f),
    pick([
      `I'd really like to resolve this between us. If I haven't received payment or heard from you within 7 days, I'll have to pause further work and consider next steps to recover it.`,
      `If payment isn't received within 7 days, I will pause any further work and take further steps to recover the debt.`,
      `If payment is not received within 7 days, I will stop all work and pursue recovery of the full amount.`,
    ], f.tone),
    payLine(f), feeLine(f),
  ],
  plan: (f) => [
    `Hi ${f.firstName},`,
    `I know cash can be tight. Invoice ${f.number} still has ${f.balance} outstanding, and I'd rather agree something workable than keep chasing.`,
    promiseLine(f),
    `Would it help to split it into two or three payments over the next few weeks? Reply with what works for you and I'll confirm it in writing.`,
    payLine(f),
  ],
};

const SUBJECTS = {
  nudge: (f) => pick([`Quick reminder: invoice ${f.number}`, `Reminder: invoice ${f.number} (${f.balance})`, `Overdue: invoice ${f.number} (${f.balance})`], f.tone),
  followup: (f) => `Following up: invoice ${f.number} (${f.balance})`,
  firm: (f) => `Payment needed: invoice ${f.number} is ${f.daysLate} days overdue`,
  final: (f) => `Final notice: invoice ${f.number}`,
  plan: (f) => `Invoice ${f.number} - shall we set up a payment plan?`,
};

const SMS = {
  nudge: (f) => `Hi ${f.firstName}, ${f.yourName || f.business || 'it'}${f.yourName || f.business ? ' here' : "'s me"} - a quick reminder that invoice ${f.number} (${f.balance}) was due ${f.due}.${f.paymentLink ? ` Pay here: ${f.paymentLink}` : ''} Thanks!`,
  followup: (f) => `Hi ${f.firstName}, following up on invoice ${f.number} (${f.balance}), due ${f.due}. When can I expect payment?${f.paymentLink ? ` ${f.paymentLink}` : ''}`,
  firm: (f) => `Hi ${f.firstName}, invoice ${f.number} (${f.balance}) is now ${f.daysLate} days overdue. Please pay within 7 days${f.paymentLink ? `: ${f.paymentLink}` : ''}.`,
  final: (f) => `Hi ${f.firstName}, final notice: invoice ${f.number} (${f.balance}) is ${f.daysLate} days overdue. Please pay within 7 days${f.paymentLink ? `: ${f.paymentLink}` : ''}.`,
  plan: (f) => `Hi ${f.firstName}, would splitting invoice ${f.number} (${f.balance}) into a few payments help? Happy to set that up.`,
};

/** The no-model draft. Deterministic: same facts, same words. */
function template(f) {
  const body = BODIES[f.kind](f).filter(Boolean).join('\n\n') + '\n\n' + signature(f);
  return {
    subject: B.clean(SUBJECTS[f.kind](f), 120),
    body: B.cleanText(body, 2400),
    sms: B.clean(SMS[f.kind](f), 320),
  };
}

module.exports = { factsFor, template, signature, toneBand };
