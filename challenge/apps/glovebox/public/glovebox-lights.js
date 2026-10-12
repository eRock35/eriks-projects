/* Glovebox - the warning-light catalogue. UMD: window.GloveboxLights in the
 * pages, require() in the server (which checks the AI's catalogue ids
 * against it) and the tests.
 *
 * 42 common dashboard symbols, each drawn as a small inline SVG (24x24,
 * stroked in currentColor so the page paints it in the light's own colour
 * on a dark "dash" tile) and grouped by what the colour means:
 *
 *   red    - STOP SAFELY NOW. Every red entry's first step says so, and the
 *            tests hold it.
 *   amber  - get it checked soon (a few lights that are amber on most cars
 *            are plain information, and say so).
 *   info   - green or blue: something is on, or working.
 *
 * Everything here is GUIDANCE, NOT A DIAGNOSIS: symbols and colours vary
 * between makes and the owner's manual wins. Nothing here says any light is
 * safe to ignore, and nothing gives repair instructions beyond the basic
 * safe checks (the oil dipstick with the engine off and cool, the tyre
 * pressures, the fuel cap) - the tests hold that too.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GloveboxLights = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GROUPS = [
    { id: 'red', label: 'Red', means: 'Stop safely now', line: 'A red light means something serious. Find a safe place to stop as soon as you can and don’t drive on until you know what it is.' },
    { id: 'amber', label: 'Amber / yellow', means: 'Get it checked soon', line: 'An amber light means something needs attention. You can usually get somewhere safe, but book it in soon - and stop if it turns red, flashes, or the car feels different.' },
    { id: 'info', label: 'Green / blue', means: 'Information', line: 'Green and blue lights tell you something is switched on or working.' },
  ];
  // The colour a light is drawn in, and the group it belongs to.
  const COLOURS = {
    red: { group: 'red', word: 'Red' },
    amber: { group: 'amber', word: 'Amber' },
    green: { group: 'info', word: 'Green' },
    blue: { group: 'info', word: 'Blue' },
  };

  // Text in an icon is drawn by the browser's own sans-serif.
  const T = (x, y, s, size) => '<text x="' + x + '" y="' + y + '" text-anchor="middle" font-size="' + (size || 6) + '" font-weight="700" font-family="Arial, Helvetica, sans-serif" fill="currentColor" stroke="none">' + s + '</text>';
  const BANG = (x, y) => '<path d="M' + x + ' ' + y + 'v4"/><path d="M' + x + ' ' + (y + 6.5) + 'v.01"/>';
  const ARCS = '<path d="M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13"/>';
  const CAR = '<path d="M6.5 10.5 8 6.5h8l1.5 4"/><rect x="4.5" y="10.5" width="15" height="4.5" rx="1.2"/><path d="M7 15v1.6M17 15v1.6"/>';
  const OILCAN = '<path d="M2.5 9.5h3v4h-3z"/><path d="M5.5 11h3l1.6-1.6h3.2l2 1.6 6-2.8-4.6 6.3H5.5z"/><path d="M11.6 9.4V7.6M9.8 7.6h3.6"/>';
  const LAMP_R = '<path d="M14 5.5c3.6 0 6.5 2.9 6.5 6.5s-2.9 6.5-6.5 6.5c-.9 0-1.4-2.9-1.4-6.5S13.1 5.5 14 5.5z"/>';
  const LAMP_L = '<path d="M10 5.5C6.4 5.5 3.5 8.4 3.5 12s2.9 6.5 6.5 6.5c.9 0 1.4-2.9 1.4-6.5S10.9 5.5 10 5.5z"/>';
  const PERSON = '<circle cx="7.5" cy="5" r="2"/><path d="M7.5 8.5v5.5h4.2l2 5"/><path d="M7.5 11h3.5"/>';

  const ICONS = {
    oilpressure: OILCAN + '<path d="M20.2 16.6a1.2 1.2 0 0 1-2.4 0c0-.9 1.2-2.4 1.2-2.4s1.2 1.5 1.2 2.4z"/>',
    coolanttemp: '<path d="M11 3.5h2v9.3"/><path d="M11 3.5v9.3"/><circle cx="12" cy="14.6" r="2"/><path d="M13 5.5h3M13 8h3M13 10.5h3"/><path d="M2.5 19.5c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 3.2-1.2 4.8 0 3.2 1.2 4.8 0"/>',
    battery: '<rect x="3" y="7.5" width="18" height="11.5" rx="1.5"/><path d="M6 7.5V5.5h3v2M15 7.5V5.5h3v2"/><path d="M6 13h4M8 11v4M14.5 13h3.5"/>',
    brake: '<circle cx="12" cy="12" r="5.5"/>' + ARCS + BANG(12, 9),
    parkbrake: '<circle cx="12" cy="12" r="5.5"/>' + ARCS + T(12, 15.2, 'P', 9),
    airbag: PERSON + '<circle cx="16.5" cy="9" r="3.3"/>',
    powersteering: '<circle cx="11" cy="13" r="7.5"/><circle cx="11" cy="13" r="2"/><path d="M3.5 13H9M13 13h5.5M11 15v5.5"/><path d="M21 2.5v4.5M21 9.8v.01"/>',
    seatbelt: '<circle cx="12" cy="4.6" r="2.1"/><path d="M7.5 21v-8.5a4.5 4.5 0 0 1 9 0V21"/><path d="M8.2 9.6 16 19.5"/><path d="M11.2 15.5h2.2"/>',
    door: '<path d="M9 2.8h6a2.5 2.5 0 0 1 2.5 2.5v13.4a2.5 2.5 0 0 1-2.5 2.5H9a2.5 2.5 0 0 1-2.5-2.5V5.3A2.5 2.5 0 0 1 9 2.8z"/><path d="M8.5 8h7"/><path d="M6.5 9.5 3 13.5M17.5 9.5l3.5 4"/>',
    bonnet: '<path d="M3 16.5h18v-3.2l-3.3-1L15.5 8H9.6l-2 3.3"/><path d="M7.6 11.3 3.5 6.5"/><circle cx="7" cy="17.5" r="1.6"/><circle cx="17" cy="17.5" r="1.6"/>',
    evfault: '<path d="M4.5 10.5 6 6.5h7.5l1.5 4"/><rect x="2.5" y="10.5" width="14.5" height="4.5" rx="1.2"/><path d="M5 15v1.6M14.5 15v1.6"/><path d="M2.5 19.5h14.5"/>' + BANG(20.5, 6.5),
    checkengine: '<path d="M7.5 7.5v-2h6v2"/><path d="M5 10h2.5l1.2-2.5h6.8l2.3 3.3h1.7V9h2.5v7.8h-2.5v-2.3h-1.7l-2.3 3.2H9.2L7.3 15.6H5z"/><path d="M5 11v4.2H2.5V11z"/>',
    abs: '<circle cx="12" cy="12" r="6.2"/>' + ARCS + T(12, 14.2, 'ABS', 5.6),
    tpms: '<path d="M5 6v7.5a7 7 0 0 0 14 0V6"/><path d="M5 6 3.3 4.2M19 6l1.7-1.8"/>' + BANG(12, 6.5) + '<path d="M5.6 18.4 4.3 20M18.4 18.4l1.3 1.6M9 20.2l-.6 1.8M15 20.2l.6 1.8"/>',
    traction: '<path d="M6.5 8 8 4h8l1.5 4"/><rect x="4.5" y="8" width="15" height="4.5" rx="1.2"/><path d="M7 12.5v1.6M17 12.5v1.6"/><path d="M7.5 22c1.4-1.1-.2-2.4 1-3.6M15.5 22c1.4-1.1-.2-2.4 1-3.6"/>',
    escoff: '<path d="M6.5 7 8 3.5h8L17.5 7"/><rect x="4.5" y="7" width="15" height="4" rx="1.1"/><path d="M7.5 15.5c1.2-1-.2-2 .8-3M15.5 15.5c1.2-1-.2-2 .8-3"/>' + T(12, 22, 'OFF', 6.2),
    lowfuel: '<path d="M4.5 20V5a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v15"/><path d="M3 20h11.5"/><path d="M6.5 6.5h5v4h-5z"/><path d="M13 9.5h2a1 1 0 0 1 1 1v5.3a1.6 1.6 0 0 0 3.2 0V8.3L17 6"/>',
    glowplug: '<path d="M2 15.5c1.6 0 1.6-7 3.3-7s1.7 7 3.4 7 1.6-7 3.3-7 1.7 7 3.4 7 1.6-7 3.3-7 1.7 7 3.3 7"/><path d="M2 19h20"/>',
    dpf: '<rect x="5" y="7" width="14" height="10" rx="2"/><path d="M2 12h3M19 12h3"/><path d="M8.5 10h.01M12 10h.01M15.5 10h.01M10.2 12.5h.01M13.8 12.5h.01M8.5 14.5h.01M12 14.5h.01M15.5 14.5h.01"/>',
    adblue: '<path d="M5 8.5h14v12H5z"/><path d="M9 8.5v-3h6v3"/><path d="M12 11.3s2.6 3 2.6 4.7a2.6 2.6 0 0 1-5.2 0c0-1.7 2.6-4.7 2.6-4.7z"/>',
    service: '<path d="M15 5.6a4.2 4.2 0 0 0-5.6 5.3l-6 6a1.7 1.7 0 0 0 2.4 2.4l6-6a4.2 4.2 0 0 0 5.3-5.6l-2.5 2.5-2.2-.5-.5-2.2z"/>',
    oillevel: OILCAN + '<path d="M3 19c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0"/>',
    brakepads: '<circle cx="12" cy="12" r="5.5"/><path d="M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13" stroke-dasharray="2.2 2.2"/>',
    washer: '<path d="M2.5 15a15 15 0 0 1 19 0l-2.2 4H4.7z"/><path d="M12 13V8.5M8.3 13.3 6.3 9M15.7 13.3l2-4.3" stroke-dasharray="1.6 1.6"/>',
    lane: '<path d="M4.5 21 8.5 3M19.5 21 15.5 3" stroke-dasharray="3 2.2"/><path d="M10 15l.6-3h2.8l.6 3z"/><rect x="9.3" y="15" width="5.4" height="2.4" rx=".6"/>',
    bulb: '<path d="M9.3 17.5h5.4M10.2 20.5h3.6"/><path d="M12 2.8a6 6 0 0 0-3.9 10.5c.7.7 1.2 1.6 1.2 2.6h5.4c0-1 .5-1.9 1.2-2.6A6 6 0 0 0 12 2.8z"/>' + BANG(12, 5.6),
    transmission: '<circle cx="12" cy="12" r="5.6"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>' + BANG(12, 9),
    turtle: '<path d="M4.5 15.5a7.5 6.5 0 0 1 15 0z"/><path d="M19.5 15.5h1.7a1.6 1.6 0 0 0 0-3.2h-1.7"/><path d="M7 15.5l-.9 3M17 15.5l.9 3M2.5 15.5h2"/><path d="M9 12.5l3-3 3 3"/>',
    airbagoff: PERSON + '<circle cx="16.5" cy="9" r="3.3"/><path d="M3 21.5 21 3"/>',
    key: '<circle cx="7" cy="12" r="3.6"/><path d="M10.6 12h7.2l1.6 1.6M15.2 12v2.5"/><path d="M21 4v4.5M21 11.3v.01"/>',
    frost: '<path d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8 20.2 7.2"/><path d="M9.5 4.2 12 6l2.5-1.8M9.5 19.8 12 18l2.5 1.8"/>',
    startstop: '<path d="M18.6 7.6A8 8 0 1 0 20 12"/><path d="M20.4 4.6v3.9h-3.9"/>' + T(12, 15, 'A', 8.5),
    highbeam: LAMP_R + '<path d="M2.5 7.5h7M2.5 10.5h7M2.5 13.5h7M2.5 16.5h7"/>',
    lowbeam: LAMP_R + '<path d="M2.5 7l7 2.2M2.5 10.5l7 2.2M2.5 14l7 2.2"/>',
    frontfog: LAMP_R + '<path d="M2.5 8l7 1.5M2.5 12l7 1.5M2.5 16l7 1.5"/><path d="M6 4.5c-1.1 1.5 1.1 2.5 0 4s1.1 2.5 0 4 1.1 2.5 0 4 1.1 2.5 0 4"/>',
    rearfog: LAMP_L + '<path d="M14.5 8h7M14.5 12h7M14.5 16h7"/><path d="M18 4.5c-1.1 1.5 1.1 2.5 0 4s1.1 2.5 0 4 1.1 2.5 0 4 1.1 2.5 0 4"/>',
    cruise: '<path d="M3.5 17.5a8.5 8.5 0 1 1 17 0"/><path d="M12 17.5l4.2-5.2"/><path d="M6.3 11.6l1.2 1M12 8.6v1.6M17.7 11.6l-1.2 1"/><circle cx="12" cy="17.5" r="1"/>',
    turn: '<path d="M10 6.5 4 12l6 5.5v-3.2h0V9.7z"/><path d="M14 6.5l6 5.5-6 5.5z"/>',
    eco: '<path d="M5 19.5c0-8.3 5.2-13.5 14.5-14.5 0 9.3-5.2 14.5-13.5 14.5z"/><path d="M5 19.5c3-4.2 6.2-7.2 9.5-9.5"/>',
    evready: '<path d="M6.5 8.5 8 4.5h8l1.5 4"/><rect x="4.5" y="8.5" width="15" height="4.5" rx="1.2"/>' + T(12, 21, 'READY', 5.6),
    lowtemp: '<path d="M10 4a2 2 0 0 1 4 0v9.6a4 4 0 1 1-4 0z"/><path d="M14 6.5h3M14 9.5h3"/><circle cx="12" cy="17" r="1.3"/>',
    sidelights: '<path d="M10 6c-2.3 1.6-2.3 10.4 0 12M14 6c2.3 1.6 2.3 10.4 0 12"/><path d="M2.5 8l4 1.6M2.5 16l4-1.6M2.5 12h4M21.5 8l-4 1.6M21.5 16l-4-1.6M21.5 12h-4"/>',
  };

  const STOP = 'Find a safe place and stop as soon as you can, then turn the engine off.';
  const MANUAL = 'Look the symbol up in your owner’s manual - symbols and colours vary between makes.';

  // id, icon, colour, name, other names (for search), what it means, how
  // urgent, what to do now, what NOT to do, a typical cause, and optional:
  // flashing (what a flashing version means), fuel (only on these cars).
  const ROWS = [
    /* ---------------- red: stop safely now ---------------- */
    { id: 'oil-pressure', icon: 'oilpressure', colour: 'red', name: 'Oil pressure', aka: 'oil can, genie lamp, oil light, low oil pressure',
      means: 'The engine has lost oil pressure - it isn’t being lubricated properly. Driving on can wreck the engine within minutes.',
      urgency: 'Stop safely now',
      now: [STOP, 'Once the engine has cooled for 10 minutes, check the oil level on the dipstick (on level ground).', 'Even if the level looks fine, don’t restart and drive - call for roadside help.'],
      dont: ['Don’t keep driving “to get home” - an engine without oil pressure can seize.', 'Don’t open anything under the bonnet (hood) while the engine is hot.'],
      cause: 'Very low oil, a failing oil pump or a blocked pickup. Sometimes a faulty sensor - but only a mechanic can tell which.' },
    { id: 'coolant-temp', icon: 'coolanttemp', colour: 'red', name: 'Engine temperature high', aka: 'thermometer, overheating, coolant, temperature, hot engine',
      means: 'The engine is overheating. Carrying on can warp or crack it.',
      urgency: 'Stop safely now',
      now: [STOP, 'Wait at least 30 minutes for it to cool before you look.', 'With the engine cold, check the coolant level against the marks on the see-through expansion tank.', 'Call for roadside help if it’s low, leaking or the light comes back.'],
      dont: ['Never open the radiator or coolant cap while the engine is hot - it can spray scalding liquid.', 'Don’t keep driving to “cool it down with air”.'],
      cause: 'Low coolant from a leak, a failed fan or thermostat, or a broken water pump.' },
    { id: 'battery', icon: 'battery', colour: 'red', name: 'Battery / charging', aka: 'battery light, charging, alternator, charge',
      means: 'The battery isn’t being charged. The car is running on what’s left in it and may cut out - including power steering and lights.',
      urgency: 'Stop safely now',
      now: [STOP, 'If it’s dark or far to go, call for roadside help rather than drive on.', 'Turn off things you don’t need (heated seats, rear demister, radio) if you must move a short way to safety.'],
      dont: ['Don’t switch off and restart again and again - it may not start.', 'Don’t touch the battery terminals or cables.'],
      cause: 'A failed alternator or a snapped drive belt, more rarely a loose battery cable.' },
    { id: 'brake', icon: 'brake', colour: 'red', name: 'Brake system', aka: 'brake light, exclamation in circle, (!), BRAKE, brake fluid',
      means: 'A problem with the brakes - often low brake fluid - or the parking brake is still on.',
      urgency: 'Stop safely now',
      now: [STOP, 'Check the parking brake is fully released. If the light goes out, that was it.', 'If it stays on, don’t drive on - call for roadside help. Brakes are not something to gamble with.'],
      dont: ['Don’t drive on if the brake pedal feels soft, low or spongy.', 'Don’t top up brake fluid and carry on - low fluid usually means a leak or worn pads.'],
      cause: 'Low brake fluid (a leak or very worn pads), a hydraulic fault, or the parking brake left on.' },
    { id: 'parking-brake', icon: 'parkbrake', colour: 'red', name: 'Parking brake on', aka: 'handbrake, (P), electronic parking brake, EPB',
      means: 'The parking brake is on. If it stays lit after you release it, there may be a fault with the parking brake.',
      urgency: 'Stop safely now if you’re moving',
      now: ['If you’re moving, stop safely and release the parking brake fully.', 'If it stays on after releasing it, don’t drive on - get it checked.'],
      dont: ['Don’t drive with the parking brake dragging - it overheats the brakes.'],
      cause: 'The handbrake not fully released, or a fault in an electronic parking brake.' },
    { id: 'airbag', icon: 'airbag', colour: 'red', name: 'Airbag / SRS', aka: 'airbag, SRS, seated person with ball, supplemental restraint',
      means: 'A fault in the airbag system. The airbags (and possibly belt tensioners) may not work in a crash.',
      urgency: 'Stop safely and get it checked before driving on',
      now: ['Stop safely when you can and check nothing is sitting on or blocking a seat or a belt buckle.', 'Book it in straight away - until it’s fixed, assume the airbags won’t protect you.'],
      dont: ['Don’t put a child in a seat with an airbag fault.', 'Don’t unplug anything under the seats - airbag wiring is dangerous to touch.'],
      cause: 'A loose connector under a seat, a faulty sensor or clock spring, or a stored crash fault.' },
    { id: 'power-steering', icon: 'powersteering', colour: 'red', name: 'Power steering fault', aka: 'steering wheel, exclamation, EPS, EPAS, steering',
      means: 'The power steering has failed or is failing. The wheel can suddenly become very heavy to turn.',
      urgency: 'Stop safely now',
      now: [STOP, 'Grip the wheel firmly - you can still steer, it just takes much more effort.', 'Call for roadside help rather than drive on.'],
      dont: ['Don’t drive on fast roads with heavy steering.'],
      cause: 'An electrical fault in electric power steering, or a fluid leak in older hydraulic systems.' },
    { id: 'seat-belt', icon: 'seatbelt', colour: 'red', name: 'Seat belt reminder', aka: 'seat belt, belt, buckle',
      means: 'Someone - you or a passenger - isn’t buckled up.',
      urgency: 'Stop safely and buckle up',
      now: ['If you’re moving and can’t see whose belt it is, stop safely first, then check everyone is buckled.', 'A heavy bag on a seat can set it off too - move it to the floor or belt it in.'],
      dont: ['Don’t drive with anyone unbelted.', 'Don’t fasten a belt behind someone to silence the chime.'],
      cause: 'An unbuckled belt, or something heavy on a passenger seat.' },
    { id: 'door-open', icon: 'door', colour: 'red', name: 'Door open', aka: 'door, door ajar, open door, car from above',
      means: 'A door (or the boot / tailgate on some cars) isn’t fully shut.',
      urgency: 'Stop safely and shut it',
      now: ['If you’re moving, stop safely, then open and firmly close each door.', 'If every door is shut and it stays on, get the door switch checked.'],
      dont: ['Don’t drive with a door that may open.'],
      cause: 'A door not latched, or a faulty door switch.' },
    { id: 'bonnet-open', icon: 'bonnet', colour: 'red', name: 'Bonnet / hood open', aka: 'hood, bonnet, hood open',
      means: 'The bonnet (hood) isn’t fully latched. At speed it can fly up and block your view.',
      urgency: 'Stop safely now',
      now: [STOP, 'Close the bonnet (hood) firmly and check it’s latched.'],
      dont: ['Don’t drive on with it unlatched, even slowly.'],
      cause: 'Not shut properly after a check, or a faulty latch switch.' },
    { id: 'ev-fault', icon: 'evfault', colour: 'red', name: 'Electric / hybrid system fault', aka: 'EV fault, high voltage, hybrid system, car with exclamation, electrical fault',
      means: 'A fault in the high-voltage battery or drive system of an electric or hybrid car. Power may drop or cut out.',
      urgency: 'Stop safely now',
      now: [STOP, 'Call your dealer or roadside help - say it’s an electric or hybrid car.'],
      dont: ['Never touch orange high-voltage cables or open the battery area.', 'Don’t keep driving until it’s been checked.'],
      cause: 'A battery, motor, inverter or cooling fault - only a qualified technician can tell.', fuel: ['ev', 'hybrid'] },

    /* ---------------- amber: get it checked soon ---------------- */
    { id: 'check-engine', icon: 'checkengine', colour: 'amber', name: 'Check engine', aka: 'engine light, CEL, MIL, engine management, malfunction indicator, emissions',
      means: 'The engine computer has found a fault - anything from a loose fuel cap to a misfire.',
      urgency: 'Get it checked soon - stop safely if it flashes',
      now: ['If it’s steady: drive gently and book a check in the next few days. Most garages can read the fault code.', 'Check the fuel cap is tight - a loose one can set it off (the light can take a few drives to clear).'],
      dont: ['Don’t put it off for weeks - a small fault can become an expensive one.', 'Don’t tow or drive hard while it’s on.'],
      cause: 'A loose fuel cap, a faulty sensor (oxygen, airflow), spark plugs or coils, or an emissions fault.',
      flashing: 'Flashing means a misfire that can overheat and ruin the catalytic converter. Slow down, stop safely and get help.' },
    { id: 'abs', icon: 'abs', colour: 'amber', name: 'ABS', aka: 'ABS, anti-lock brakes, anti-lock',
      means: 'The anti-lock braking system has a fault. Normal brakes still work, but the wheels can lock in a hard stop.',
      urgency: 'Get it checked soon',
      now: ['Drive carefully, leave more space, and book it in soon.', 'If the red brake light comes on too, stop safely - that’s more serious.'],
      dont: ['Don’t brake late or hard if you can avoid it, especially in the wet.'],
      cause: 'A dirty or faulty wheel-speed sensor is the commonest cause.' },
    { id: 'tpms', icon: 'tpms', colour: 'amber', name: 'Tyre pressure (TPMS)', aka: 'tire pressure, tyre, horseshoe, flat tire, TPMS, low tyre',
      means: 'One or more tyres is low on air - or the pressure monitor has a fault.',
      urgency: 'Check your tyres soon',
      now: ['Slow down and look at each tyre when you can stop safely. A visibly flat or damaged tyre: don’t drive on it - fit the spare or call for help.', 'Otherwise check the pressures at a garage air line and pump to the figures on the door-pillar sticker.'],
      dont: ['Don’t drive fast or far on a low tyre - it overheats and can fail.'],
      cause: 'A slow puncture, cold weather lowering pressures, or a sensor needing a reset.',
      flashing: 'Flashing for a minute then staying on usually means a sensor fault rather than low pressure - still get the tyres checked.' },
    { id: 'traction', icon: 'traction', colour: 'amber', name: 'Traction / stability control (ESC)', aka: 'ESC, ESP, traction control, TCS, car with squiggly lines, skid',
      means: 'Flickering while you drive: the system is working, catching a slip. Staying on: the system has a fault and won’t help in a skid.',
      urgency: 'Slow down; get it checked if it stays on',
      now: ['If it flickers, the road is slippery - ease off and drive gently.', 'If it stays on, drive carefully and book a check soon.'],
      dont: ['Don’t brake or steer sharply on a slippery road.'],
      cause: 'Slippery roads (flickering), or a wheel-speed or steering-angle sensor fault (steady).' },
    { id: 'esc-off', icon: 'escoff', colour: 'amber', name: 'Stability control off', aka: 'ESC OFF, ESP OFF, TCS OFF, traction off',
      means: 'Stability / traction control has been switched off - by a button, or by the car after a fault.',
      urgency: 'Turn it back on',
      now: ['Press the ESC / traction button to switch it back on.', 'If it won’t come back on, drive gently and get it checked.'],
      dont: ['Don’t leave it off on ordinary roads - it’s there to catch skids.'],
      cause: 'The button pressed by accident, or a fault elsewhere (it often comes on with the check-engine light).' },
    { id: 'low-fuel', icon: 'lowfuel', colour: 'amber', name: 'Low fuel', aka: 'fuel pump, gas, petrol, diesel, fuel, empty',
      means: 'You’re running on reserve - usually 30-80 km (20-50 miles) left, less on hills or in traffic.',
      urgency: 'Fill up soon',
      now: ['Head for the nearest fuel station.'],
      dont: ['Don’t keep running it nearly empty - it’s hard on the fuel pump.', 'Don’t trust the range estimate to the last mile.'],
      cause: 'The tank is low.' },
    { id: 'glow-plug', icon: 'glowplug', colour: 'amber', name: 'Glow plug (diesel)', aka: 'coil, spiral, pig tail, glow plug, pre-heat',
      means: 'On start-up: the engine is pre-heating - wait for it to go out before starting. Staying on or flashing while driving: an engine fault.',
      urgency: 'Get it checked if it stays on',
      now: ['When starting, wait for it to go out, then start the engine.', 'If it flashes or stays on while driving, book a check soon.'],
      dont: ['Don’t crank the engine before it goes out on a cold morning.'],
      cause: 'Normal pre-heating; or a failed glow plug or an engine-management fault.', fuel: ['diesel'] },
    { id: 'dpf', icon: 'dpf', colour: 'amber', name: 'Diesel particulate filter (DPF)', aka: 'DPF, soot filter, exhaust filter, box with dots',
      means: 'The soot filter in the exhaust is getting blocked - it needs a run to clean itself.',
      urgency: 'Get it sorted soon',
      now: ['Your manual will say how: usually 15-20 minutes at a steady motorway / highway speed clears it.', 'If it doesn’t clear, or the car loses power, get it checked soon.'],
      dont: ['Don’t ignore it on short trips - a fully blocked filter is expensive to replace.'],
      cause: 'Lots of short, slow journeys that never get the exhaust hot enough to burn the soot off.', fuel: ['diesel'] },
    { id: 'adblue', icon: 'adblue', colour: 'amber', name: 'AdBlue / DEF low', aka: 'AdBlue, DEF, diesel exhaust fluid, urea, SCR',
      means: 'The diesel exhaust fluid (AdBlue / DEF) is low or has a fault. Many cars won’t restart once it runs out.',
      urgency: 'Top up soon',
      now: ['Buy AdBlue / DEF at a fuel station and top up the right filler (usually blue cap, by the fuel cap or under the bonnet (hood)) - check your manual.', 'If it says “fault” rather than “low”, book a check.'],
      dont: ['Never put AdBlue in the fuel tank, or diesel in the AdBlue tank.', 'Don’t leave it until the countdown reaches zero.'],
      cause: 'The fluid is used up as you drive; or a sensor / heater fault.', fuel: ['diesel'] },
    { id: 'service-due', icon: 'service', colour: 'amber', name: 'Service due', aka: 'spanner, wrench, service, maintenance required, oil change due',
      means: 'A reminder that a scheduled service is due (or nearly due).',
      urgency: 'Book a service',
      now: ['Book the service. The garage resets the reminder.', 'Log it in Glovebox when it’s done, so your history is complete.'],
      dont: ['Don’t keep pushing it back - a missed service can affect a warranty.'],
      cause: 'Time or distance since the last service.' },
    { id: 'oil-level', icon: 'oillevel', colour: 'amber', name: 'Oil level low', aka: 'oil can with wavy line, oil level, low oil',
      means: 'The engine oil level is low (different from the red oil-pressure light).',
      urgency: 'Check and top up soon',
      now: ['Park on level ground, turn the engine off and wait 10 minutes.', 'Check the dipstick and top up with the oil your manual specifies, a little at a time.', 'If it keeps dropping, get it checked for a leak or burning oil.'],
      dont: ['Don’t overfill - too much oil is also bad for the engine.', 'If the red oil-pressure light comes on, stop safely straight away.'],
      cause: 'The engine using oil between services, or a leak.' },
    { id: 'brake-pads', icon: 'brakepads', colour: 'amber', name: 'Brake pads worn', aka: 'brake pad, dashed circle, brake wear',
      means: 'The brake pads are wearing thin and need replacing soon.',
      urgency: 'Book new pads soon',
      now: ['Book the brakes in within the next week or two.', 'Leave more room to stop meanwhile.'],
      dont: ['Don’t wait for grinding noises - that’s metal on the discs, and a bigger bill.'],
      cause: 'Normal wear; the pad sensor has touched the disc.' },
    { id: 'washer-fluid', icon: 'washer', colour: 'amber', name: 'Washer fluid low', aka: 'windscreen, windshield, washer, wiper fluid, screen wash',
      means: 'The windscreen washer bottle is nearly empty.',
      urgency: 'Top up soon',
      now: ['Top up with screen wash (the cap usually shows a windscreen symbol).'],
      dont: ['Don’t use plain water in freezing weather, or washing-up liquid.'],
      cause: 'You’ve used it up.' },
    { id: 'lane-assist', icon: 'lane', colour: 'amber', name: 'Lane assist / driver aid fault', aka: 'lane departure, lane keeping, lines, LKA, LDW, driver assistance',
      means: 'A driver-assistance system (lane keeping, collision warning) isn’t available - often because a camera or sensor is dirty or blocked.',
      urgency: 'Get it checked if it stays on',
      now: ['When stopped safely, clean the windscreen around the camera and the badges / bumpers where radar sits.', 'If it stays on, drive as if the system isn’t there and book a check.'],
      dont: ['Don’t rely on it while the light is on.'],
      cause: 'Dirt, snow or ice on a sensor; a windscreen replaced without recalibration; or a fault.' },
    { id: 'bulb-out', icon: 'bulb', colour: 'amber', name: 'Exterior bulb fault', aka: 'bulb, light out, lamp failure, lightbulb',
      means: 'One of the outside lights - headlight, brake light, indicator - isn’t working.',
      urgency: 'Fix it soon',
      now: ['Walk round the car with the lights on to find which (ask someone to press the brake).', 'Get it replaced soon - a missing brake light or indicator is a real danger, and illegal in most places.'],
      dont: ['Don’t drive at night with a headlight out if you can avoid it.'],
      cause: 'A blown bulb or a failed LED unit.' },
    { id: 'transmission', icon: 'transmission', colour: 'amber', name: 'Transmission / gearbox fault', aka: 'gear, cog, gearbox, transmission temperature, AT, automatic',
      means: 'A fault or overheating in the gearbox. Some cars show it in red when the gearbox is hot.',
      urgency: 'Get it checked soon - stop safely if it’s red',
      now: ['If it’s red, or the car jerks, slips or won’t change gear: stop safely and let it cool or call for help.', 'Otherwise drive gently and book a check soon.'],
      dont: ['Don’t tow or drive hard with it on.'],
      cause: 'Overheating (towing, hills, traffic), low fluid, or an electronic fault.' },
    { id: 'reduced-power', icon: 'turtle', colour: 'amber', name: 'Reduced power (turtle / limp mode)', aka: 'turtle, tortoise, limp mode, reduced power, power limited',
      means: 'The car has limited its power to protect itself - on electric cars, often because the battery is very low or very cold.',
      urgency: 'Get somewhere safe and get it checked',
      now: ['Expect slow acceleration - don’t try to overtake.', 'On an EV: charge as soon as you can. Otherwise, stop safely when you can and book a check.'],
      dont: ['Don’t join fast roads while power is limited.'],
      cause: 'A very low or cold battery on an EV; an engine or drive fault on others.' },
    { id: 'airbag-off', icon: 'airbagoff', colour: 'amber', name: 'Passenger airbag off', aka: 'passenger airbag off, PASS AIRBAG OFF, airbag disabled',
      means: 'The front passenger airbag is switched off - on purpose for a rear-facing child seat, or because the seat sensor thinks the seat is empty.',
      urgency: 'Information - check it’s meant to be off',
      now: ['If an adult is in the front seat, the airbag should be on - check the key switch (often on the dashboard edge) and sit properly in the seat.', 'If it’s wrong and won’t change, get it checked.'],
      dont: ['Never put a rear-facing child seat in front of an active airbag.'],
      cause: 'Deliberately switched off, or a light passenger or a seat-sensor fault.' },
    { id: 'key', icon: 'key', colour: 'amber', name: 'Key not detected', aka: 'key, smart key, key fob, immobiliser',
      means: 'The car can’t find the key - often a flat fob battery. It may not restart once you turn it off.',
      urgency: 'Sort it before you switch off',
      now: ['Check the key is in the car. Hold the fob against the start button - many cars read it there even with a flat battery.', 'Replace the fob battery soon.'],
      dont: ['Don’t switch off somewhere remote until you know it will restart.'],
      cause: 'A flat key battery, interference, or the key left outside the car.' },
    { id: 'frost', icon: 'frost', colour: 'amber', name: 'Frost / ice warning', aka: 'snowflake, ice, frost, cold, freezing',
      means: 'The outside temperature is near freezing - the road may be icy.',
      urgency: 'Drive for ice',
      now: ['Slow down and leave much more space - bridges and shaded roads freeze first.'],
      dont: ['Don’t brake or steer sharply.'],
      cause: 'Cold weather.' },
    { id: 'start-stop', icon: 'startstop', colour: 'amber', name: 'Auto start-stop', aka: 'A with arrow, start stop, auto stop, idle stop',
      means: 'Green: the engine has stopped itself at a standstill to save fuel. Amber (often with a line through it): start-stop is off or unavailable.',
      urgency: 'Usually information - get it checked if it shows a fault',
      now: ['If it says unavailable, it’s often the battery being low or the engine still cold - it usually comes back.', 'If your manual says it’s a fault, book a check.'],
      dont: ['Don’t assume the engine is off - it restarts as you lift off the brake.'],
      cause: 'Normal operation, a cold engine, a low battery, or a system fault.' },
    { id: 'rear-fog', icon: 'rearfog', colour: 'amber', name: 'Rear fog light on', aka: 'rear fog, fog light',
      means: 'Your rear fog light is on. It’s amber on most cars, but it’s just a reminder - nothing is wrong.',
      urgency: 'Information',
      now: ['Use it only when you can’t see far in fog - switch it off when visibility improves.'],
      dont: ['Don’t leave it on in rain or clear weather - it dazzles drivers behind and hides your brake lights.'],
      cause: 'Switched on.' },

    /* ---------------- green / blue: information ---------------- */
    { id: 'high-beam', icon: 'highbeam', colour: 'blue', name: 'High beam / main beam', aka: 'full beam, brights, headlights, main beam',
      means: 'Your high beams are on.',
      urgency: 'Information',
      now: ['Dip them for oncoming traffic and when following another car.'],
      dont: ['Don’t dazzle other drivers.'],
      cause: 'Switched on.' },
    { id: 'low-beam', icon: 'lowbeam', colour: 'green', name: 'Low beam / dipped headlights', aka: 'dipped, headlights, lights on, low beam',
      means: 'Your headlights are on.',
      urgency: 'Information',
      now: ['Nothing to do - use them from dusk, in rain and in poor light.'],
      dont: ['Don’t rely on daytime running lights at night: often your rear lights aren’t on with them.'],
      cause: 'Switched on (or automatic headlights).' },
    { id: 'front-fog', icon: 'frontfog', colour: 'green', name: 'Front fog lights', aka: 'fog lights, front fog',
      means: 'Your front fog lights are on.',
      urgency: 'Information',
      now: ['Use them in fog or very poor visibility.'],
      dont: ['Don’t use them in clear weather - they can dazzle.'],
      cause: 'Switched on.' },
    { id: 'cruise', icon: 'cruise', colour: 'green', name: 'Cruise control', aka: 'speedometer, cruise, speed control, ACC',
      means: 'Cruise control is on or set.',
      urgency: 'Information',
      now: ['Keep your feet ready - tap the brake to cancel.'],
      dont: ['Don’t use it in heavy rain, ice or busy traffic.'],
      cause: 'Switched on.' },
    { id: 'turn-signal', icon: 'turn', colour: 'green', name: 'Turn signals / hazards', aka: 'indicators, blinkers, arrows, hazard lights',
      means: 'An indicator is on - or both, for hazard lights. Flashing much faster than usual means a bulb has failed.',
      urgency: 'Information',
      now: ['Cancel it after your turn. If it flashes fast, get the bulb replaced.'],
      dont: ['Don’t leave an indicator on - it misleads other drivers.'],
      cause: 'Switched on; fast flashing - a blown bulb.' },
    { id: 'eco', icon: 'eco', colour: 'green', name: 'Eco mode', aka: 'leaf, eco, economy',
      means: 'An economy driving mode is on, or you’re driving economically.',
      urgency: 'Information',
      now: ['Nothing to do.'],
      dont: ['Don’t forget the car may respond more gently - allow for it when overtaking.'],
      cause: 'Switched on.' },
    { id: 'ev-ready', icon: 'evready', colour: 'green', name: 'Ready to drive (EV / hybrid)', aka: 'READY, car with arrows, ready, EV',
      means: 'An electric or hybrid car is on and will move when you press the accelerator - even though it’s silent.',
      urgency: 'Information',
      now: ['Treat it like a running engine: select Park before getting out.'],
      dont: ['Don’t leave the car while it says Ready.'],
      cause: 'The car is switched on.', fuel: ['ev', 'hybrid'] },
    { id: 'low-temp', icon: 'lowtemp', colour: 'blue', name: 'Engine cold', aka: 'blue thermometer, cold engine, low temperature',
      means: 'The engine hasn’t warmed up yet.',
      urgency: 'Information',
      now: ['Drive gently until it goes out.'],
      dont: ['Don’t rev hard on a cold engine.', 'If it never goes out, get the thermostat checked.'],
      cause: 'A cold start.' },
    { id: 'sidelights', icon: 'sidelights', colour: 'green', name: 'Sidelights / parking lights', aka: 'side lights, parking lights, position lights',
      means: 'Your sidelights are on.',
      urgency: 'Information',
      now: ['Switch to headlights when it gets dark or visibility drops.'],
      dont: ['Don’t drive at night on sidelights alone.'],
      cause: 'Switched on.' },
  ];

  const LIGHTS = ROWS.map((r) => Object.assign({}, r, { group: COLOURS[r.colour].group, svg: ICONS[r.icon] }));
  const BY_ID = Object.create(null);
  LIGHTS.forEach((l) => { BY_ID[l.id] = l; });
  function light(id) { return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : null; }
  function inGroup(g) { return LIGHTS.filter((l) => l.group === g); }
  /** The whole icon as markup. Only ever our own strings. */
  function svg(l, cls) {
    return '<svg class="' + (cls || 'li') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + l.svg + '</svg>';
  }
  /** Type-ahead: name first, then the words people call it. */
  function find(q, limit) {
    const s = String(q || '').toLowerCase().replace(/[^a-z0-9 ()!/-]/g, ' ').trim();
    if (!s) return [];
    const words = s.split(/\s+/);
    const scored = [];
    for (const l of LIGHTS) {
      const name = l.name.toLowerCase(); const aka = l.aka.toLowerCase();
      let sc = 0;
      if (name.indexOf(s) === 0) sc = 4; else if (name.indexOf(s) >= 0) sc = 3; else if (aka.indexOf(s) >= 0) sc = 2;
      else if (words.every((w) => name.indexOf(w) >= 0 || aka.indexOf(w) >= 0)) sc = 1;
      if (sc) scored.push([sc, l]);
    }
    return scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).slice(0, limit || 12).map((x) => x[1]);
  }
  const SEVERITY = { info: 0, amber: 1, red: 2 };
  const FUEL_WORDS = { diesel: 'Diesel cars', ev: 'Electric cars', hybrid: 'Hybrids' };

  return { GROUPS, COLOURS, LIGHTS, ICONS, light, inGroup, svg, find, SEVERITY, FUEL_WORDS };
});
