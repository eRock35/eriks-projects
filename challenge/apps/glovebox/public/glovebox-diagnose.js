/* Glovebox - "Light or noise?": the rules for the AI's likely cause.
 *
 * A model looks at a photo of a warning light, or listens to a few seconds
 * of a noise, and PICKS from lists this file owns. Every word a driver reads
 * about how urgent it is, and what to do, is written here - never by the
 * model:
 *
 *   - the urgency is one of four (stop_now, soon, can_wait, not_sure), each
 *     with fixed safety wording;
 *   - the likely cause is one of CAUSES (or "unknown"), each with a plain
 *     sentence written here and its own floor;
 *   - a red or flashing light, a light Glovebox's own list marks red, and
 *     anything about brakes, steering, overheating, smoke or a fuel smell is
 *     ALWAYS stop_now, whatever the model says (cleanDiagnosis, run on the
 *     server and again on the page);
 *   - "it can wait" is only ever said for a named cause that allows it;
 *     anything else the model called minor comes back "not sure";
 *   - a mechanic should confirm, said every time.
 *
 * The one free-text field (what the model saw or heard) is description
 * only: bounded, stripped, and any sentence about safety, urgency or what to
 * do is dropped (GloveboxCore.scrubSafe), then checked for the same danger
 * words. No request, no storage: UMD, run by the page, the server and the
 * tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./glovebox-core'));
  else root.GloveboxDiagnose = factory(root.GloveboxCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var L = C.Lights;
  var URGENCIES = ['stop_now', 'soon', 'can_wait', 'not_sure'];
  var CONFIRM = 'A mechanic should confirm this. It’s a likely cause from a photo or a few seconds of sound - not a diagnosis.';

  /** The fixed wording. Nothing here is ever replaced by a model's words. */
  var URGENCY = {
    stop_now: {
      label: 'Stop safely now',
      line: 'Find a safe place, pull over and switch the engine off. Don’t drive on until it has been checked - call roadside help or a mechanic.',
    },
    soon: {
      label: 'Get it checked soon',
      line: 'Book a mechanic in the next few days and drive gently until then. If it gets worse, a red light comes on, or anything changes with the brakes, steering, temperature, smoke or a fuel smell - stop safely.',
    },
    can_wait: {
      label: 'It can wait for your next visit',
      line: 'Mention it to a mechanic at the next service. If it changes, gets louder, or a warning light comes on, get it checked sooner.',
    },
    not_sure: {
      label: 'Not sure',
      line: 'This can’t be told from a photo or a short sound. Until a mechanic has looked, treat it as something to get checked soon - and if a red light is on, or it involves the brakes, steering, temperature, smoke or a fuel smell, stop safely.',
    },
  };

  /** Why an answer was raised to "stop now" - said in the app's words. */
  var REASONS = {
    'red-light': 'A red warning light always means stop safely.',
    flashing: 'A flashing warning light is always treated as stop now.',
    catalogue: 'Glovebox’s own list marks this light as stop safely.',
    hazard: 'Anything about brakes, steering, overheating, smoke or a fuel smell is always treated as stop now.',
  };
  var REASON_IDS = Object.keys(REASONS);

  var HAZARDS = ['brakes', 'steering', 'overheating', 'smoke', 'fuel_smell'];
  var COLOURS = ['red', 'amber', 'green', 'blue', 'white', 'unknown'];
  var FLASH = ['yes', 'no', 'unknown'];
  var SOUNDS = ['none', 'squeal', 'grinding', 'knocking', 'ticking', 'clicking', 'hissing', 'rattle', 'hum', 'clunk', 'other'];
  var SOUND_WORD = { squeal: 'A squeal', grinding: 'A grinding noise', knocking: 'A knocking noise', ticking: 'A ticking noise', clicking: 'A clicking noise', hissing: 'A hiss', rattle: 'A rattle', hum: 'A hum or whine', clunk: 'A clunk', other: 'A noise' };
  var CONFIDENCE = ['low', 'medium', 'high'];

  /** The causes a model may pick. `floor` is the least urgent this cause is
   *  ever shown as; `hazard` marks brakes, steering, overheating, smoke and
   *  fuel; only `wait: true` causes may ever be "can wait". No line tells
   *  anyone how to repair anything. */
  var CAUSES = [
    { id: 'brake-wear', label: 'Worn brake pads or discs', line: 'A squeal or grinding when you brake usually means the pads are worn down, sometimes to the metal.', floor: 'stop_now', hazard: true },
    { id: 'brake-system', label: 'A brake system fault', line: 'Low brake fluid, a fault in the braking system or the ABS, or a brake that is binding.', floor: 'stop_now', hazard: true },
    { id: 'steering', label: 'A power steering fault', line: 'Low steering fluid or a fault in the power steering - the wheel can turn heavy without warning.', floor: 'stop_now', hazard: true },
    { id: 'overheating', label: 'The engine running too hot', line: 'Low coolant, a leak, or a failed fan or water pump. Heat damages an engine quickly.', floor: 'stop_now', hazard: true },
    { id: 'oil-pressure', label: 'Low oil pressure or oil level', line: 'The engine may not be getting the oil it needs. Running it can wreck it in minutes.', floor: 'stop_now' },
    { id: 'fuel-leak', label: 'A fuel leak or fuel vapour', line: 'A smell of fuel can mean a leak, which is a fire risk.', floor: 'stop_now', hazard: true },
    { id: 'burning', label: 'Something overheating or burning', line: 'Smoke or a burning smell can come from the brakes, the clutch, wiring or oil on a hot engine.', floor: 'stop_now', hazard: true },
    { id: 'charging', label: 'The battery isn’t charging', line: 'Often the alternator or its belt. The car runs on the battery alone until it is flat.', floor: 'soon' },
    { id: 'misfire', label: 'An engine misfire', line: 'One cylinder isn’t firing properly - commonly spark plugs, a coil or fuelling.', floor: 'soon' },
    { id: 'engine-fault', label: 'An engine or emissions fault', line: 'The car’s computer has logged a fault. A garage can read the code in a few minutes.', floor: 'soon' },
    { id: 'tyre-pressure', label: 'Low tyre pressure', line: 'One or more tyres is below its pressure, or the sensor has a fault.', floor: 'soon' },
    { id: 'wheel-bearing', label: 'A worn wheel bearing', line: 'A hum or growl that rises with road speed often comes from a wheel bearing.', floor: 'soon' },
    { id: 'drive-belt', label: 'A slipping or worn drive belt', line: 'A squeal on start-up or when the engine is revved is often the belt that drives the alternator and pumps.', floor: 'soon' },
    { id: 'exhaust', label: 'An exhaust leak or loose exhaust', line: 'A blowing, rasping or rattling from underneath, often louder when you accelerate.', floor: 'soon' },
    { id: 'suspension', label: 'Worn suspension or a loose part underneath', line: 'A clunk or knock over bumps often comes from a worn joint, bush or link.', floor: 'soon' },
    { id: 'cv-joint', label: 'A worn CV joint', line: 'A rhythmic clicking on full lock, when pulling away in a turn, often comes from a driveshaft joint.', floor: 'soon' },
    { id: 'transmission', label: 'A gearbox or clutch fault', line: 'A whine, a crunch or a slipping feeling that follows the gears.', floor: 'soon' },
    { id: 'engine-knock', label: 'A knock from the engine', line: 'A deep knock or a loud tick from the engine itself can mean low oil or internal wear.', floor: 'soon' },
    { id: 'battery-weak', label: 'A weak 12V battery or starter', line: 'A slow turn-over or rapid clicking when you try to start usually points at the battery or the starter.', floor: 'soon' },
    { id: 'airbag', label: 'An airbag or seat belt system fault', line: 'The airbags may not work in a crash until this is fixed.', floor: 'soon' },
    { id: 'emissions-filter', label: 'A blocked exhaust filter (DPF) or low AdBlue', line: 'Diesels warn when the particulate filter needs clearing or the AdBlue is running low.', floor: 'soon' },
    { id: 'low-fuel', label: 'Low fuel', line: 'The tank is nearly empty.', floor: 'soon' },
    { id: 'door-open', label: 'A door, boot or bonnet not fully shut', line: 'Something isn’t latched.', floor: 'soon' },
    { id: 'loose-trim', label: 'A loose heat shield or trim', line: 'A tinny rattle at certain revs is very often a thin metal heat shield or a piece of trim working loose.', floor: 'can_wait', wait: true },
    { id: 'wipers-washers', label: 'Worn wiper blades or low washer fluid', line: 'Juddering or squeaking wipers, or the washer-fluid light.', floor: 'can_wait', wait: true },
    { id: 'service-due', label: 'A service reminder', line: 'The car is counting down to its next routine service.', floor: 'can_wait', wait: true },
    { id: 'info-light', label: 'An information light, not a warning', line: 'It shows that something is switched on - lights, cruise control, indicators.', floor: 'can_wait', wait: true },
  ];
  var CAUSE_IDS = CAUSES.map(function (c) { return c.id; });
  function cause(id) { for (var i = 0; i < CAUSES.length; i++) if (CAUSES[i].id === id) return CAUSES[i]; return null; }

  /** Words that mean brakes, steering, overheating, smoke or fuel - looked
   *  for in the driver's own note and in what the model said it noticed. */
  var DANGER = /\bbrak(e|es|ing)\b|\bsteer|\boverheat|\bover-heat|\brunning hot\b|\btoo hot\b|\btemperature\b|\bsteam|\bsmok|\bburn|\bfire\b|\bfuel (smell|leak)|\b(petrol|gasoline|gas|diesel|fuel)\b[^.]{0,24}\b(smell|leak|drip)|\b(smell|leak|drip)\w*\b[^.]{0,24}\b(petrol|gasoline|gas|diesel|fuel)\b/i;
  function dangerWords(s) { return DANGER.test(String(s || '')); }

  /** What the model noticed is description only: a sentence that tells the
   *  driver what to do, or how to mend anything, is dropped. */
  var ADVICE = /\b(you|your mechanic|should|must|need(s)? to|recommend\w*|advis\w*|replace|tighten|top[- ]up|refill|add (some |more )?(oil|coolant|fluid|water)|fix\w*|repair\w*|adjust\w*|continue|carry on|don.?t worry|safe|fine|ok(ay)?)\b/i;
  function describeOnly(s) { return C.scrubSafe(s).split(/(?<=[.!?])\s+/).filter(function (x) { return !ADVICE.test(x); }).join(' ').trim(); }

  var RANK = { can_wait: 0, not_sure: 1, soon: 2, stop_now: 3 };
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function pick(list, v, fallback) { return typeof v === 'string' && list.indexOf(v) >= 0 ? v : fallback; }

  /**
   * A model's answer (or an already cleaned one) -> what the page may show.
   * Idempotent. `ctx.note` is the driver's own optional note.
   */
  function cleanDiagnosis(raw, ctx) {
    var r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var note = C.clean(ctx && ctx.note, 200);
    var lraw = r.light && typeof r.light === 'object' ? r.light : {};
    var lightId = own(r, 'catalogueId') ? r.catalogueId : lraw.id;
    var cat = typeof lightId === 'string' ? L.light(lightId) : null;
    var colour = pick(COLOURS, own(r, 'lightColour') ? r.lightColour : lraw.colour, 'unknown');
    var flashing = pick(FLASH, own(r, 'flashing') ? r.flashing : lraw.flashing, 'unknown');
    var sound = pick(SOUNDS, r.sound, 'none');
    var c = cause(typeof r.cause === 'string' ? r.cause : '');
    var confidence = pick(CONFIDENCE, r.confidence, 'low');
    var observed = describeOnly(C.clean(r.observed, 160));
    var hazards = (Array.isArray(r.hazards) ? r.hazards : []).filter(function (h, i, a) { return HAZARDS.indexOf(h) >= 0 && a.indexOf(h) === i; }).slice(0, HAZARDS.length);
    var said = pick(URGENCIES, r.urgency, 'not_sure');
    var hasLight = Boolean(cat) || colour !== 'unknown';

    // Why it must be "stop now", whatever the model said.
    var reasons = [];
    if (colour === 'red') reasons.push('red-light');
    if (flashing === 'yes') reasons.push('flashing');
    if (cat && cat.group === 'red' && reasons.indexOf('red-light') < 0) reasons.push('catalogue');
    if (hazards.length || (c && c.hazard) || dangerWords(note) || dangerWords(observed)) reasons.push('hazard');

    var urgency;
    if (reasons.length || (c && c.floor === 'stop_now')) urgency = 'stop_now';
    else {
      urgency = said;
      // "It can wait" needs a named cause that allows it and a confident
      // answer; otherwise the honest answer is "not sure".
      if (urgency === 'can_wait' && !(c && c.wait && confidence !== 'low')) urgency = 'not_sure';
      // An amber light, or a named cause, is never less than "soon" - unless
      // the model itself was not sure, which stays not sure.
      if (urgency !== 'not_sure') {
        if (c && RANK[c.floor] > RANK[urgency]) urgency = c.floor;
        if ((colour === 'amber' || (cat && cat.group === 'amber')) && RANK.soon > RANK[urgency] && !(c && c.wait)) urgency = 'soon';
      }
      if (!c && urgency === 'soon' && !hasLight && confidence === 'low') urgency = 'not_sure';
    }

    return {
      relevant: r.relevant !== false,
      urgency: urgency,
      reasons: urgency === 'stop_now' ? reasons : [],
      cause: c ? c.id : null,
      light: { id: cat ? cat.id : null, colour: colour, flashing: flashing },
      sound: sound,
      hazards: hazards,
      observed: observed,
      confidence: confidence,
    };
  }

  return {
    URGENCIES: URGENCIES, URGENCY: URGENCY, REASONS: REASONS, REASON_IDS: REASON_IDS, CONFIRM: CONFIRM,
    HAZARDS: HAZARDS, COLOURS: COLOURS, FLASH: FLASH, SOUNDS: SOUNDS, SOUND_WORD: SOUND_WORD, CONFIDENCE: CONFIDENCE,
    CAUSES: CAUSES, CAUSE_IDS: CAUSE_IDS, cause: cause, dangerWords: dangerWords, cleanDiagnosis: cleanDiagnosis,
    LIMITS: { note: 200, audioSeconds: 15, audioBytes: 1536 * 1024, photoBytes: 2 * 1024 * 1024, photoPx: 1280 },
  };
}));
