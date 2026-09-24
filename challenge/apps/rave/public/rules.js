/* Rave's rules - everything that needs no model, in one file that runs in the
 * browser AND on the server (server.js requires it).
 *
 *   heat(text, ctx)      0-100 and the reasons: the thermometer.
 *   lint(reply, ctx)     the reply checklist.
 *   quickTriage(review)  topics, praise vs complaints, the risk flag.
 *
 * One implementation on purpose: the page lints and heats a reply live as it
 * is typed, the server lints what it saves and heats what the model returns,
 * and the two can never disagree about what "too hot" means. The model never
 * decides a heat number - it rewrites, and these rules measure both sides.
 *
 * Keyword rules are blunt. They are a floor, not a judge: the model's triage
 * can add a risk reason the words missed, but it can never remove one these
 * rules raised (server.js merges them), because "someone says they got sick"
 * must not depend on a model's mood.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RaveRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- vocabulary ---------------- */

  var TOPICS = [
    { key: 'food', label: 'Food', emoji: '🍳', words: ['food', 'dish', 'dishes', 'meal', 'eggs', 'brunch', 'breakfast', 'lunch', 'dinner', 'sandwich', 'burger', 'pizza', 'cake', 'pastry', 'pastries', 'bun', 'buns', 'bread', 'sourdough', 'taste', 'tasty', 'tasted', 'delicious', 'flavor', 'flavour', 'portion', 'portions', 'menu', 'cooked', 'bland', 'stale', 'hash', 'chicken', 'salad', 'soup', 'croissant', 'toast', 'pancakes', 'bagel'] },
    { key: 'drink', label: 'Drinks', emoji: '☕', words: ['coffee', 'latte', 'lattes', 'espresso', 'cappuccino', 'flat white', 'tea', 'drink', 'drinks', 'cocktail', 'cocktails', 'wine', 'beer', 'smoothie', 'juice', 'matcha', 'chai'] },
    { key: 'service', label: 'Service', emoji: '🛎️', words: ['service', 'served', 'attentive', 'ignored', 'customer service', 'helpful', 'unhelpful', 'hospitality', 'welcomed', 'welcoming'] },
    { key: 'staff', label: 'Staff', emoji: '🧑‍🍳', words: ['staff', 'team', 'employee', 'employees', 'barista', 'baristas', 'waiter', 'waitress', 'server', 'stylist', 'technician', 'tech', 'receptionist', 'manager', 'owner', 'friendly', 'rude', 'polite', 'attitude', 'rolled his eyes', 'rolled her eyes', 'rolled their eyes', 'kind', 'crew', 'barber', 'barbers', 'hairdresser', 'dentist', 'hygienist', 'nurse', 'doctor', 'plumber', 'electrician', 'contractor'] },
    { key: 'wait', label: 'Wait & speed', emoji: '⏱️', words: ['wait', 'waited', 'waiting', 'slow', 'quick', 'quickly', 'fast', 'minutes', 'hour', 'hours', 'delay', 'delayed', 'on time', 'prompt', 'promptly', 'took forever', 'queue', 'line was'] },
    { key: 'price', label: 'Price & value', emoji: '💲', words: ['price', 'prices', 'pricey', 'expensive', 'cheap', 'overpriced', 'value', 'worth', 'cost', 'costs', 'charged', 'charge', 'bill', 'affordable', 'rip off', 'ripoff', 'rip-off'] },
    { key: 'quality', label: 'Quality of work', emoji: '🛠️', words: ['quality', 'workmanship', 'craftsmanship', 'results', 'finish', 'repair', 'repaired', 'fixed', 'broke', 'broken', 'haircut', 'cut', 'colour', 'color', 'nails', 'install', 'installed', 'job', 'fade', 'trim', 'shave', 'blowout', 'manicure', 'pedicure', 'filling'] },
    { key: 'cleanliness', label: 'Cleanliness', emoji: '🧼', words: ['clean', 'dirty', 'filthy', 'hair in', 'a hair', 'spotless', 'bathroom', 'restroom', 'toilet', 'sticky', 'hygiene', 'smelled', 'smelly', 'gross', 'bug', 'bugs', 'cockroach'] },
    { key: 'atmosphere', label: 'Atmosphere', emoji: '🪴', words: ['atmosphere', 'vibe', 'vibes', 'ambiance', 'ambience', 'cozy', 'cosy', 'noisy', 'loud', 'music', 'decor', 'patio', 'seating', 'comfortable', 'crowded', 'cramped', 'charming', 'dog-friendly', 'dog friendly'] },
    { key: 'booking', label: 'Booking', emoji: '📅', words: ['booking', 'booked', 'reservation', 'reservations', 'reserve', 'reserved', 'appointment', 'appointments', 'rescheduled', 'cancelled', 'canceled', 'no-show', 'walk-in'] },
    { key: 'communication', label: 'Communication', emoji: '💬', words: ['called', 'emailed', 'texted', 'reply', 'replied', 'respond', 'responded', 'communication', 'communicated', 'updates', 'explained', 'quote', 'estimate', 'catered', 'catering', 'organised', 'organized'] },
    { key: 'location', label: 'Location & parking', emoji: '📍', words: ['parking', 'location', 'accessible', 'wheelchair', 'located', 'neighborhood', 'neighbourhood', 'hard to find', 'street'] },
  ];
  var TOPIC_KEYS = TOPICS.map(function (t) { return t.key; });

  var RISKS = [
    { key: 'health', label: 'Health', detail: 'Someone says they got sick, hurt or had a reaction.', re: /\b(food poisoning|poison(ed|ing)?|got sick|made (me|us|my \w+) (sick|ill)|was sick|were sick|threw up|throwing up|vomit\w*|diarrh\w*|stomach (cramps?|ache|bug|pain)|allergic reaction|anaphyla\w*|epipen|hospital|emergency room|rash|infection|infected|injur\w*|undercooked (chicken|pork|meat)|raw chicken|burn(ed|t) (my|me|her|his))\b/i },
    { key: 'safety', label: 'Safety', detail: 'An accident, a hazard or violence is described.', re: /\b(unsafe|dangerous|slipped|fell|fire hazard|gas leak|electrocut\w*|broken glass|hazard\w*|assault\w*|attacked|punched|shoved)\b/i },
    { key: 'legal', label: 'Legal', detail: 'Lawyers, lawsuits, regulators or the police are mentioned.', re: /\b(lawyers?|attorneys?|sue|suing|sued|lawsuit|legal action|small claims|court|health (department|inspector|dept)|report(ed|ing)? (you|this|it) to|police|better business bureau|bbb|fraud|scam(med)?|chargeback)\b/i },
    { key: 'discrimination', label: 'Discrimination', detail: 'They say they were treated differently for who they are.', re: /\b(racist|racism|racial|discriminat\w*|sexist|sexism|homophob\w*|transphob\w*|bigot\w*|slurs?|profil(ed|ing)|because (i|we)('m|'re| am| are) (black|asian|latin[oa]|hispanic|muslim|jewish|gay|lesbian|trans|disabled|old|a woman|women|foreign))\b/i },
    { key: 'harassment', label: 'Harassment', detail: 'Unwanted contact, threats or intimidation are described.', re: /\b(harass\w*|creepy|inappropriate(ly)? (touch\w*|comments?)|hit on me|stalk\w*|threaten\w*|intimidat\w*)\b/i },
    { key: 'privacy', label: 'Privacy', detail: 'They say their personal details were shared or misused.', re: /\b((shared|posted|gave out|leaked|sold) my (number|phone|address|details|information|info|email|photos?)|privacy)\b/i },
  ];
  var RISK_KEYS = RISKS.map(function (r) { return r.key; });

  // What a hot reply does. Also the enum the cool-down tool must answer in.
  var KINDS = [
    { key: 'blame', emoji: '👉', label: 'Blamed the customer' },
    { key: 'private', emoji: '🔓', label: 'Shared private details' },
    { key: 'sarcasm', emoji: '🙄', label: 'Sarcasm' },
    { key: 'insult', emoji: '🤬', label: 'Name-calling' },
    { key: 'profanity', emoji: '💥', label: 'Swearing' },
    { key: 'caps', emoji: '📢', label: 'SHOUTING' },
    { key: 'exclaim', emoji: '‼️', label: 'Exclamation storm' },
    { key: 'threat', emoji: '⚖️', label: 'Threats or legal talk' },
    { key: 'argue', emoji: '🥊', label: 'Argued the facts' },
    { key: 'dismiss', emoji: '🚪', label: 'Told them not to come back' },
    { key: 'defensive', emoji: '🛡️', label: 'Got defensive' },
    { key: 'other', emoji: '✂️', label: 'Other heat' },
  ];
  var KIND_KEYS = KINDS.map(function (k) { return k.key; });
  function kindInfo(k) { for (var i = 0; i < KINDS.length; i++) if (KINDS[i].key === k) return KINDS[i]; return KINDS[KINDS.length - 1]; }

  var POS = ['love', 'loved', 'loves', 'amazing', 'great', 'excellent', 'fantastic', 'best', 'friendly', 'delicious', 'perfect', 'perfectly', 'wonderful', 'awesome', 'lovely', 'helpful', 'recommend', 'fresh', 'clean', 'quick', 'fast', 'beautiful', 'cozy', 'cosy', 'kind', 'attentive', 'on time', 'raved', 'worth', 'spotless', 'favorite', 'favourite', 'gem', 'incredible', 'superb', 'nice', 'good', 'happy', 'charming', 'welcoming', 'thank', 'thanks', 'reasonable', 'fair', 'generous'];
  var NEG = ['worst', 'terrible', 'awful', 'bad', 'rude', 'cold', 'slow', 'dirty', 'stale', 'overpriced', 'never', 'disappointing', 'disappointed', 'horrible', 'sick', 'waited', 'noisy', 'loud', 'tiny', 'small', 'bland', 'expensive', 'pricey', 'ignored', 'hair', 'burnt', 'late', 'broken', 'rolled', 'not', "didn't", "wasn't", "weren't", 'no one', 'nobody', 'forever', 'filthy', 'gross', 'unprofessional', 'mediocre', 'meh', 'dry', 'soggy', 'cramped', 'rip off', 'ripoff', 'avoid', 'shame', 'unfortunately', 'sadly', 'but'];

  /* ---------------- helpers ---------------- */

  // Curly quotes straightened, so "don’t" matches the same rules as "don't".
  function str(v) { return String(v == null ? '' : v).replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"'); }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function wordRe(words) {
    return new RegExp('(^|[^a-z0-9])(' + words.map(function (w) { return esc(w).replace(/ /g, '\\s+'); }).join('|') + ')(?=$|[^a-z0-9])', 'gi');
  }
  function count(text, re) { re.lastIndex = 0; var m = text.match(re); return m ? m.length : 0; }
  function firstMatch(text, re) { re.lastIndex = 0; var m = re.exec(text); re.lastIndex = 0; return m ? m[0].replace(/^[^a-z0-9]+/i, '').trim() : ''; }
  function wordsOf(text) { return str(text).trim().split(/\s+/).filter(Boolean); }
  function sentences(text) { return str(text).replace(/([.!?])\s+/g, '$1\n').split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function snippet(text, i, n) { return str(text).slice(Math.max(0, i - 10), i + (n || 50)).replace(/\s+/g, ' ').trim(); }

  var TOPIC_RE = {};
  TOPICS.forEach(function (t) { TOPIC_RE[t.key] = wordRe(t.words); });
  var POS_RE = wordRe(POS);
  var NEG_RE = wordRe(NEG);

  /** "Brett Lawson" -> "Brett"; "A Google user" / "Anonymous" -> "". */
  function firstName(name) {
    var n = str(name).replace(/[^\p{L}\p{M}' .-]/gu, ' ').trim();
    if (!n || /^(a |an )?(google |yelp )?(user|customer|guest|anonymous|anon)\b/i.test(n)) return '';
    var w = n.split(/\s+/)[0].replace(/\.$/, '');
    return w.length > 1 ? w.charAt(0).toUpperCase() + w.slice(1) : '';
  }
  /** "Brett Lawson" -> "Brett L." for anything public. */
  function displayName(name) {
    var f = firstName(name);
    if (!f) return 'A customer';
    var parts = str(name).trim().split(/\s+/);
    var last = parts.length > 1 ? parts[parts.length - 1].replace(/[^\p{L}]/gu, '') : '';
    return last ? f + ' ' + last.charAt(0).toUpperCase() + '.' : f;
  }
  /** The reviewer's full name, when they gave one worth protecting. */
  function fullName(name) {
    var parts = str(name).trim().split(/\s+/).filter(function (p) { return p.replace(/[^\p{L}]/gu, '').length > 1; });
    return parts.length >= 2 ? parts.slice(0, 2).join(' ') : '';
  }

  /* ---------------- heat ---------------- */

  var CAPS_OK = /^(OK|BBQ|USA|UK|ASAP|FYI|TV|DJ|GPS|PS|ATM|ID|AM|PM|IPA|BLT|PB|LLC|INC|CEO|HVAC|DIY|RSVP|NYC|LA|SF|DC|EU|VIP|WIFI|WI-FI)$/;

  var HEAT = [
    { kind: 'profanity', w: 12, max: 30, re: /\b(damn|dammit|hell|crap|crappy|shit\w*|sh\*t|f\*+k\w*|fuck\w*|wtf|bs|bullshit|piss(ed)?|ass|asshole|bastard|bloody)\b/gi },
    { kind: 'insult', w: 12, max: 30, re: /\b(idiot\w*|liar|lying|moron\w*|pathetic|clown|entitled|troll|ridiculous|garbage|clueless|stupid|dumb|loser|karen|childish|delusional|lunatic|jerk|rude people|cheapskate|freeloader|nutcase|psycho)\b/gi },
    { kind: 'blame', w: 10, max: 25, re: /\b(you should have|you shouldn'?t have|your (own )?fault|if you had|if you'?d|maybe (if )?you|people like you|you clearly|you obviously|learn to|nobody forced you|you chose to|you decided to|you failed to|you didn'?t even|you never (told|asked|said)|you showed up|you came in (late|at))\b/gi },
    { kind: 'sarcasm', w: 8, max: 16, re: /(\bsorry you feel\b|\boh wow\b|\bthanks for nothing\b|\bcongrat(s|ulations)\b|\bgood luck with that\b|\bmust be nice\b|\bwhat a shock\b|\bshocking\b|\bbless your heart\b|\/s\b|\blol\b|\blmao\b|\bsure,? jan\b|\bheaven forbid\b|🙄|😂)/gi },
    { kind: 'threat', w: 14, max: 28, re: /\b(sue|suing|lawyers?|attorney|legal action|report you|we know (who|where) you|banned|blacklist(ed)?|defamation|slander|libel|take this down or)\b/gi },
    { kind: 'argue', w: 8, max: 16, re: /(\bthat'?s not true\b|\bnever happened\b|\byou'?re (wrong|lying|mistaken)\b|\bthat'?s a lie\b|\bour (records|cameras|camera footage|footage|receipts?) show\b|\byou claim\b|\bthat is false\b|\bcompletely false\b|\bmade (this|that|it) up\b|\bnobody else complained\b|\bno one else complained\b)/gi },
    { kind: 'dismiss', w: 12, max: 20, re: /\b(don'?t (bother )?(come|coming) back|never come back|go somewhere else|go elsewhere|take your business elsewhere|not welcome|good riddance|we don'?t need (your|customers like)|won'?t be missed)\b/gi },
    { kind: 'defensive', w: 6, max: 12, re: /\b(we did nothing wrong|not our (fault|problem)|we are not responsible|we'?re not responsible|it'?s not our job|we can'?t help (it|that) if|as i already said|like i said)\b/gi },
  ];

  function heatRule(kind) { for (var i = 0; i < HEAT.length; i++) if (HEAT[i].kind === kind) return HEAT[i]; return null; }

  var PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/g;
  var EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi;
  var ORDER_RE = /\b(order|reservation|booking|table|invoice|receipt|account|ticket|confirmation)\s*(#|no\.?|number)?\s*:?\s*[A-Z]*\d{3,}\b/gi;

  function allowed(contactLine) {
    var s = str(contactLine);
    return {
      digits: (s.match(PHONE_RE) || []).map(function (p) { return p.replace(/\D/g, ''); }),
      emails: (s.match(EMAIL_RE) || []).map(function (e) { return e.toLowerCase(); }),
    };
  }

  /** Private details in a public reply: other people's phone numbers and
   *  emails (the owner's own contact line is fine), order and booking
   *  numbers, and the reviewer's full name. */
  function privateBits(text, ctx) {
    ctx = ctx || {};
    var ok = allowed(ctx.contactLine);
    var out = [];
    var m;
    PHONE_RE.lastIndex = 0;
    while ((m = PHONE_RE.exec(text))) {
      var d = m[1].replace(/\D/g, '');
      if (d.length >= 7 && ok.digits.indexOf(d) < 0 && !/^(19|20)\d{2}$/.test(d)) out.push(m[1].trim());
    }
    EMAIL_RE.lastIndex = 0;
    while ((m = EMAIL_RE.exec(text))) if (ok.emails.indexOf(m[0].toLowerCase()) < 0) out.push(m[0]);
    ORDER_RE.lastIndex = 0;
    while ((m = ORDER_RE.exec(text))) out.push(m[0].trim());
    var full = fullName(ctx.reviewer);
    if (full && new RegExp('\\b' + esc(full).replace(/ /g, '\\s+') + '\\b', 'i').test(text)) out.push(full);
    return out;
  }

  /**
   * How hot a reply reads, 0-100, with every reason and the words that
   * triggered it. Deterministic, so the before/after on the cool-down is a
   * measurement rather than a model's opinion of its own work.
   */
  function heat(text, ctx) {
    var t = str(text);
    var flags = [];
    var score = 0;
    function add(kind, pts, sample) {
      if (pts <= 0) return;
      score += pts;
      var info = kindInfo(kind);
      flags.push({ kind: kind, emoji: info.emoji, label: info.label, sample: str(sample).slice(0, 60), points: pts });
    }
    // Capitals: whole words of three letters or more, minus the usual acronyms.
    var capsWords = (t.match(/\b[A-Z][A-Z'!?]{2,}\b/g) || []).filter(function (w) { return !CAPS_OK.test(w.replace(/[!?']/g, '')); });
    if (capsWords.length) add('caps', Math.min(20, capsWords.length * 6), capsWords.slice(0, 3).join(' '));
    var runs = (t.match(/[!?]{2,}/g) || []).length;
    var bangs = (t.match(/!/g) || []).length;
    if (runs || bangs > 2) add('exclaim', Math.min(12, runs * 4 + (bangs > 2 ? 2 : 0)), (t.match(/(?:[^\s.!?]+[ \t]+){0,4}[^\s.!?]*[!?]{2,}/) || [''])[0].trim() || '!!!');
    HEAT.forEach(function (h) {
      var n = count(t, h.re);
      if (n) add(h.kind, Math.min(h.max, n * h.w), firstMatch(t, h.re));
    });
    var priv = privateBits(t, ctx);
    if (priv.length) add('private', Math.min(28, priv.length * 14), priv[0]);
    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score: score, level: score < 15 ? 'cool' : score < 35 ? 'warm' : score < 60 ? 'hot' : 'boiling', flags: flags };
  }

  /* ---------------- lint ---------------- */

  function norm(text) { return str(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function shingles(text) {
    var w = norm(text).split(' ').filter(Boolean);
    var s = {};
    for (var i = 0; i + 2 < w.length; i++) s[w[i] + ' ' + w[i + 1] + ' ' + w[i + 2]] = 1;
    return s;
  }
  /** Jaccard over word triples: "Hi Maya, thanks so much…" and "Hi Tom,
   *  thanks so much…" score well above the copy-paste line. */
  function similarity(a, b) {
    var x = shingles(a), y = shingles(b);
    var kx = Object.keys(x), ky = Object.keys(y);
    if (kx.length < 4 || ky.length < 4) return norm(a) && norm(a) === norm(b) ? 1 : 0;
    var inter = 0;
    kx.forEach(function (k) { if (y[k]) inter++; });
    return inter / (kx.length + ky.length - inter);
  }
  var COPY_LINE = 0.8;

  /** Any phone number or email from the owner's contact line counts as an
   *  invitation offline, however the sentence around it is worded. */
  function mentionsContact(text, contactLine) {
    var c = str(contactLine).trim();
    if (!c) return false;
    if (text.indexOf(c) >= 0) return true;
    var ok = allowed(c);
    var digits = text.replace(/\D/g, '');
    return ok.emails.some(function (e) { return text.toLowerCase().indexOf(e) >= 0; }) ||
      ok.digits.some(function (d) { return d.length >= 7 && digits.indexOf(d) >= 0; });
  }

  var OFFLINE_RE = /\b(call|phone|email|e-mail|reach (out|me|us)|contact|get in touch|message (me|us)|dm|speak (with|to) you|talk (with|to) you|come (in|by) and (see|ask for)|ask for me|my (direct )?(number|line|email)|drop (me|us) a)\b/i;
  var ADMIT_RE = /\b(our fault|we made you sick|made you ill|food poisoning from (our|the)|we (were|are) negligent|we admit|it was (definitely |clearly )?(our|the kitchen'?s) fault|we take full (responsibility|liability)|we accept (full )?liability)\b/i;
  var PLACEHOLDER_RE = /(\[[^\]\n]{1,30}\]|\{\{?[^}\n]{1,30}\}\}?|\bXXX+\b|\bTBD\b|\binsert (name|date|number)\b)/i;
  var THANKS_RE = /\b(thank|thanks|grateful|appreciate)/i;

  /**
   * The checklist a reply goes through before it goes public. Levels:
   * error (don't post this), warn (think again), tip (could be better).
   *
   * @param ctx { stars, reviewer, contactLine, risk, others: [{id, label, text}] }
   */
  function lint(reply, ctx) {
    ctx = ctx || {};
    var text = str(reply).trim();
    var words = wordsOf(text).length;
    var issues = [];
    function add(key, level, label, detail) { issues.push({ key: key, level: level, label: label, detail: detail || '' }); }
    var h = heat(text, ctx);
    if (!text) {
      add('empty', 'error', 'Nothing written yet', 'Write a reply, use a template, or let Rave draft one.');
      return { ok: false, words: 0, heat: h, issues: issues };
    }
    var ph = text.match(PLACEHOLDER_RE);
    if (ph) add('placeholder', 'error', 'Fill in the placeholder', '“' + ph[0] + '” would be posted as it is.');
    if (words > 150) add('long', 'warn', 'Too long (' + words + ' words)', 'Long replies read as defensive, and nobody reads them. Aim for 40–120 words.');
    else if (words < 12 && Number(ctx.stars) <= 3) add('short', 'tip', 'A bit short for an unhappy review', 'Name the specific problem they raised so it doesn’t read as a form letter.');
    var others = ctx.others || [];
    for (var i = 0; i < others.length; i++) {
      if (!others[i] || !others[i].text) continue;
      if (similarity(text, others[i].text) >= COPY_LINE) {
        add('copy', 'warn', 'Reads copy-pasted', 'Nearly identical to your reply to ' + (others[i].label || 'another review') + '. Readers scroll past identical replies — mention something they actually said.');
        break;
      }
    }
    var full = fullName(ctx.reviewer);
    if (full && new RegExp('\\b' + esc(full).replace(/ /g, '\\s+') + '\\b', 'i').test(text)) {
      add('fullname', 'warn', 'Uses their full name', 'Say “' + (firstName(ctx.reviewer) || 'their first name') + '” — their surname is theirs to share, not yours.');
    }
    var priv = privateBits(text, { contactLine: ctx.contactLine }).filter(function (p) { return !full || p.toLowerCase() !== full.toLowerCase(); });
    if (priv.length) add('private', 'warn', 'Shares private details', '“' + priv[0] + '” — keep order numbers, phone numbers and emails that aren’t yours off the public page.');
    var argue = firstMatch(text, heatRule('argue').re);
    if (argue) add('argue', 'warn', 'Argues the facts', '“' + argue + '” — readers side with the customer. Acknowledge, then take the details offline.');
    var unhappy = Number(ctx.stars) > 0 && Number(ctx.stars) <= 2;
    if ((unhappy || ctx.risk) && !OFFLINE_RE.test(text) && !mentionsContact(text, ctx.contactLine)) {
      add('offline', 'warn', 'No invitation to talk offline', ctx.contactLine
        ? 'For a ' + (ctx.risk ? 'sensitive' : ctx.stars + '★') + ' review, give them your contact line: “' + str(ctx.contactLine).trim() + '”.'
        : 'For a ' + (ctx.risk ? 'sensitive' : ctx.stars + '★') + ' review, give them a way to reach you directly. Add a contact line in Settings and Rave will suggest it.');
    }
    if (ctx.risk && ADMIT_RE.test(text)) add('admit', 'warn', 'Could read as admitting fault', 'On a health, safety or legal complaint, say you’re sorry they had a bad experience and take it offline — don’t settle the facts in public.');
    if (h.score >= 35) add('heat', 'warn', 'Still running ' + h.level + ' (' + h.score + '°)', 'Try Cool down before this goes public.');
    else if (h.score >= 15) add('heat', 'tip', 'A little warm (' + h.score + '°)', h.flags.map(function (f) { return f.label; }).join(', ') + '.');
    if (Number(ctx.stars) >= 4 && !THANKS_RE.test(text)) add('thanks', 'tip', 'Say thank you', 'A happy customer took the time — thank them first.');
    var bad = issues.some(function (x) { return x.level !== 'tip'; });
    return { ok: !bad, words: words, heat: h, issues: issues };
  }

  /* ---------------- quick triage ---------------- */

  function sentimentOf(stars, praise, complaints) {
    stars = Number(stars) || 0;
    if (stars >= 5) return complaints.length > praise.length ? 'mixed' : 'positive';
    if (stars === 4) return complaints.length ? 'mixed' : 'positive';
    if (stars === 3) return 'mixed';
    return praise.length > complaints.length ? 'mixed' : 'negative';
  }

  /**
   * Topics, what was praised and what was complained about, and the risk
   * flag - from keywords and the star rating alone. Free, instant, and the
   * floor under the model's triage.
   */
  function quickTriage(review) {
    var text = str(review && review.text);
    var stars = Number(review && review.stars) || 0;
    var praise = {}, complaints = {}, topics = {};
    sentences(text).forEach(function (s) {
      var pos = count(s, POS_RE), neg = count(s, NEG_RE);
      var pol = pos - neg;
      if (!pol) pol = stars >= 4 ? 1 : stars && stars <= 2 ? -1 : 0;
      TOPIC_KEYS.forEach(function (k) {
        // A price is often only a figure: "$45 for this?"
        if (count(s, TOPIC_RE[k]) || (k === 'price' && /[$£€]\s?\d/.test(s))) {
          topics[k] = 1;
          if (pol > 0) praise[k] = 1; else if (pol < 0) complaints[k] = 1;
        }
      });
    });
    var p = Object.keys(praise), c = Object.keys(complaints);
    var reasons = RISKS.filter(function (r) { return r.re.test(text); }).map(function (r) { return r.key; });
    return {
      sentiment: sentimentOf(stars, p, c),
      topics: TOPIC_KEYS.filter(function (k) { return topics[k]; }),
      praise: TOPIC_KEYS.filter(function (k) { return praise[k]; }),
      complaints: TOPIC_KEYS.filter(function (k) { return complaints[k]; }),
      risk: { flag: reasons.length > 0, reasons: reasons },
      urgency: urgencyOf(stars, reasons.length > 0),
      summary: '',
      approach: '',
      by: 'rules',
    };
  }

  /** Risk first, then how unhappy. */
  function urgencyOf(stars, risk) {
    if (risk) return 'urgent';
    stars = Number(stars) || 0;
    if (stars && stars <= 2) return 'high';
    if (stars === 3) return 'normal';
    return 'low';
  }
  var URGENCY = ['low', 'normal', 'high', 'urgent'];

  function topicInfo(k) { for (var i = 0; i < TOPICS.length; i++) if (TOPICS[i].key === k) return TOPICS[i]; return { key: k, label: k, emoji: '•' }; }
  function riskInfo(k) { for (var i = 0; i < RISKS.length; i++) if (RISKS[i].key === k) return RISKS[i]; return { key: k, label: k, detail: '' }; }

  return {
    TOPICS: TOPICS.map(function (t) { return { key: t.key, label: t.label, emoji: t.emoji }; }),
    TOPIC_KEYS: TOPIC_KEYS,
    RISKS: RISKS.map(function (r) { return { key: r.key, label: r.label, detail: r.detail }; }),
    RISK_KEYS: RISK_KEYS,
    KINDS: KINDS,
    KIND_KEYS: KIND_KEYS,
    URGENCY: URGENCY,
    COPY_LINE: COPY_LINE,
    heat: heat,
    lint: lint,
    quickTriage: quickTriage,
    urgencyOf: urgencyOf,
    similarity: similarity,
    privateBits: privateBits,
    firstName: firstName,
    displayName: displayName,
    fullName: fullName,
    kindInfo: kindInfo,
    topicInfo: topicInfo,
    riskInfo: riskInfo,
  };
});
