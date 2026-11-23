// A short voice memo for "Scan a card": checked on the way in, heard once by
// the model, dropped.
//
// The memo is the rep's own note to self ("Riley, wants pricing on the 5 lb
// bags, call next week"). It is never written anywhere - not to the store,
// not to a bucket, not to a log. It arrives as base64 in one request (the
// page records at most 12 seconds and stops itself), is validated here BEFORE
// anything is spent, goes to the model inline, and is garbage when the
// request ends. What survives is the one-line summary the rep reads, edits
// and chooses to save as the lead's note.
//
// The length is held on the phone; here the SIZE is the cap (1 MB decoded -
// far more than 15 seconds of a phone's recording), the real type is read
// from the first bytes (a declared type is a claim), and a WAV - the one
// container whose length is a sum - is refused past 15 seconds.

const MAX_BYTES = 1024 * 1024;
const MAX_SECONDS = 15;
const TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/flac'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

/** The real type from the first bytes, or null. */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';
  const four = buf.slice(0, 4).toString('latin1');
  if (four === 'OggS') return 'audio/ogg';
  if (four === 'fLaC') return 'audio/flac';
  if (four === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  if (four.slice(0, 3) === 'ID3') return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'audio/aac';   // ADTS
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';  // an MPEG audio frame
  return null;
}

/** Seconds of a PCM WAV from its header, or null when it cannot be told. */
function wavSeconds(buf) {
  let at = 12;
  let rate = 0;
  while (at + 8 <= buf.length) {
    const id = buf.slice(at, at + 4).toString('latin1');
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 20 <= buf.length) rate = buf.readUInt32LE(at + 16); // byte rate
    if (id === 'data') return rate > 0 ? Math.min(size, buf.length - at - 8) / rate : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

/**
 * @param raw  { type, data } where data is base64 or a data: URL
 * @returns    { mediaType, data } ready to go inline to the model
 */
function validate(raw) {
  if (!raw || typeof raw !== 'object') throw httpError(400, 'Record the memo first.');
  let data = String(raw.data || '');
  const m = data.match(/^data:([a-z0-9/+.;=\s-]+);base64,/i);
  if (m) data = data.slice(m[0].length);
  if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw httpError(400, 'That memo could not be read. Try recording it again.');
  if (Math.floor(data.replace(/\s/g, '').length * 3 / 4) > MAX_BYTES + 3) throw httpError(400, `That memo is too big. Keep it to ${MAX_SECONDS} seconds.`);
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw httpError(400, 'That memo is empty.');
  if (buf.length > MAX_BYTES) throw httpError(400, `That memo is too big. Keep it to ${MAX_SECONDS} seconds.`);
  const actual = sniff(buf);
  if (!actual) throw httpError(400, 'The memo must be a sound recording.');
  if (actual === 'audio/wav') {
    const secs = wavSeconds(buf);
    if (secs !== null && secs > MAX_SECONDS + 0.5) throw httpError(400, `That memo is longer than ${MAX_SECONDS} seconds. Record a shorter one.`);
  }
  return { mediaType: actual, data: buf.toString('base64') };
}

module.exports = { validate, sniff, wavSeconds, MAX_BYTES, MAX_SECONDS, TYPES };
