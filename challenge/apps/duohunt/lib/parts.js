// Apple's US part numbers for iPhone Duo, confirmed from Apple itself.
//
// Source: apple.com buy page products JSON, 2026-10-24. Apple's own buy page
// (https://www.apple.com/shop/buy-iphone/iphone-duo, HTTP 200, fetched by a
// Cloud Build step from Google's network) embeds a "products" JSON with one
// US part number per storage and colour. The carrier versions share it, so
// unlocked, AT&T, Verizon and T-Mobile get the same number.
//
// The part number is what "See this model on Apple" opens
// (/shop/product/<PART>) and what the iPhone Shortcut asks Apple about. A
// wrong one would not fail loudly - Apple would answer about some other
// phone - which is why nothing was guessed before Apple's own page said so:
// the 1TB Star White number one blog gave (MK2P4LL/A) was not Apple's.
//
// A row must match PART_RE (`MK1E4LL/A`) or partFor() treats it as unset.

const { PART_RE } = require('../public/duohunt-core');

const STORAGES = ['256gb', '512gb', '1tb', '2tb'];
const COLOURS = ['star-white', 'night-sky'];
const CARRIERS = ['unlocked', 'att', 'verizon', 'tmobile'];

const SOURCE = 'apple.com buy page products JSON, 2026-10-24';

// One part per storage and colour, as the buy page lists them. Prices are
// the buy page's where it showed one for that row.
const BY_MODEL = {
  '256gb:star-white': 'MK1E4LL/A', // $1,999
  '256gb:night-sky': 'MK1F4LL/A', // $1,999
  '512gb:star-white': 'MK1G4LL/A', // $2,199
  '512gb:night-sky': 'MK1H4LL/A', // $2,199
  '1tb:star-white': 'MK1J4LL/A',
  '1tb:night-sky': 'MK1L4LL/A', // $2,599
  '2tb:star-white': 'MK1Q4LL/A', // $3,199
  '2tb:night-sky': 'MK1R4LL/A',
};

// key: `${storage}:${colour}:${carrier}` - every one of the 32 picks.
const PARTS = {};
for (const s of STORAGES) for (const c of COLOURS) for (const k of CARRIERS) {
  PARTS[`${s}:${c}:${k}`] = { part: BY_MODEL[`${s}:${c}`], source: SOURCE };
}

/** Clearly fake part numbers for DUOHUNT_FAKE_UPSTREAM (local runs, tests):
 *  Z + four characters, which no Apple part starts with. */
function fakePart(pick) {
  const s = STORAGES.indexOf(pick.storage), c = COLOURS.indexOf(pick.colour), k = CARRIERS.indexOf(pick.carrier);
  return `ZD${s}${c}${k}LL/A`;
}

/** The part number for a (clean) pick, or null when not configured. */
function partFor(pick, { fake = false, table = PARTS } = {}) {
  if (!pick) return null;
  if (fake) return fakePart(pick);
  const row = table[`${pick.storage}:${pick.colour}:${pick.carrier}`];
  const part = row && typeof row.part === 'string' ? row.part.trim().toUpperCase() : '';
  return PART_RE.test(part) ? part : null;
}

module.exports = { PARTS, BY_MODEL, SOURCE, PART_RE, partFor, fakePart };
