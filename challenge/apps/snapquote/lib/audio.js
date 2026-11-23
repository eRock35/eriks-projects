// The voice note for "Read the job": checked on the way in, heard once by the
// model, dropped.
//
// Never written anywhere - not to a store, not to a bucket, not to a log. It
// arrives as base64 in one request (the page stops recording at 60 seconds),
// is validated here BEFORE anything is spent, goes to the model inline, and
// is garbage when the request ends. Same promise as the photos.
//
// The length is held on the phone; here the SIZE is the cap (2 MB decoded -
// a minute of a phone's compressed recording is well under half of that),
// the real type is read from the first bytes (a declared type is a claim),
// and a WAV - the one container whose length is a sum - is refused past a
// minute.

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SECONDS = 60;
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
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

/** Seconds of a PCM WAV from its header, or null when it cannot be told. */
function wavSeconds(buf) {
  let at = 12;
  let rate = 0;
  while (at + 8 <= buf.length) {
    const id = buf.slice(at, at + 4).toString('latin1');
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 20 <= buf.length) rate = buf.readUInt32LE(at + 16);
    if (id === 'data') return rate > 0 ? Math.min(size, buf.length - at - 8) / rate : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

/**
 * @param raw  { type, data } where data is base64 or a data: URL; null for none
 * @returns    { mediaType, data } ready to go inline to the model, or null
 */
function validate(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw httpError(400, 'That voice note could not be read. Record it again.');
  let data = String(raw.data || '');
  const m = data.match(/^data:([a-z0-9/+.;=\s-]+);base64,/i);
  if (m) data = data.slice(m[0].length);
  if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw httpError(400, 'That voice note could not be read. Record it again.');
  const tooBig = `That voice note is too big. Keep it to ${MAX_SECONDS} seconds.`;
  if (Math.floor(data.replace(/\s/g, '').length * 3 / 4) > MAX_BYTES + 3) throw httpError(400, tooBig);
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw httpError(400, 'That voice note is empty.');
  if (buf.length > MAX_BYTES) throw httpError(400, tooBig);
  const actual = sniff(buf);
  if (!actual) throw httpError(400, 'The voice note must be a sound recording.');
  if (actual === 'audio/wav') {
    const secs = wavSeconds(buf);
    if (secs !== null && secs > MAX_SECONDS + 0.5) throw httpError(400, `That voice note is longer than ${MAX_SECONDS} seconds. Record a shorter one.`);
  }
  return { mediaType: actual, data: buf.toString('base64') };
}

module.exports = { validate, sniff, wavSeconds, MAX_BYTES, MAX_SECONDS, TYPES };
