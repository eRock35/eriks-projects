// Apple's US part numbers for iPhone Duo - the owner fills these in.
//
// Apple's pickup check is asked by part number ("MK1E4LL/A"), one per
// storage, colour and carrier. On 2026-10-24 none of them could be confirmed
// from Apple itself: two 256GB numbers appear only in one reseller's catalog,
// and one 1TB number on one blog (CLAUDE.md, "Part numbers"). A wrong part
// number would not fail loudly - Apple would answer about some other phone,
// or say "unavailable" forever - so nothing is guessed. Every row starts
// `null`, and the Apple card says "Apple's check isn't set up for this model
// yet" with a link to Apple's page.
//
// How to fill a row: open the model on apple.com in a desktop browser, pick
// storage, colour and carrier, and read the part number from the URL
// (/shop/buy-iphone/iphone-duo/... then "Check availability" shows it), or
// from the "Product Information" on the bag page. It looks like `MK1E4LL/A`.
// `seen` is where a candidate was found and is never used by the code.

const STORAGES = ['256gb', '512gb', '1tb', '2tb'];
const COLOURS = ['star-white', 'night-sky'];
const CARRIERS = ['unlocked', 'att', 'verizon', 'tmobile'];

const PART_RE = /^[A-Z0-9]{5}LL\/A$/;

// key: `${storage}:${colour}:${carrier}`
const PARTS = {
  '256gb:star-white:unlocked': { part: null, seen: 'MK1E4LL/A - SHI reseller catalog listing, unconfirmed' },
  '256gb:night-sky:unlocked': { part: null, seen: 'MK1F4LL/A - SHI reseller catalog listing, unconfirmed' },
  '1tb:star-white:unlocked': { part: null, seen: 'MK2P4LL/A - TechWalls model-number article, unconfirmed' },
};
for (const s of STORAGES) for (const c of COLOURS) for (const k of CARRIERS) {
  const key = `${s}:${c}:${k}`;
  if (!PARTS[key]) PARTS[key] = { part: null, seen: null };
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

module.exports = { PARTS, PART_RE, partFor, fakePart };
