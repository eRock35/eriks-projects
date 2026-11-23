// One meeting recording for "Record or snap": checked on the way in, heard
// once by the model, dropped.
//
// Never written anywhere - not to the store, not to a bucket, not to a log.
// It arrives as base64 in one request, is checked here BEFORE anything is
// spent, goes to the model inline, and is garbage when the request ends. A
// recording of a meeting holds whatever the room said; it is not ours to
// keep, and the transcription that comes back is not stored either.
//
// The cap is 30 minutes, held on the phone (the recorder stops itself there
// and a chosen file longer than that is refused before it is sent). Here the
// SIZE is the cap - 8 MB decoded, which is 30 minutes of speech at the 32
// kbit/s the page records at, with room to spare - the real type is read from
// the first bytes (a declared type is a claim), and a WAV, the one container
// whose length is a sum, is refused past 30 minutes.
//
// The base64 is never decoded whole: the lab is one process for every app,
// and an 8 MB recording copied three times is memory the others need. Only
// the head is decoded, for the type and a WAV's header.

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MINUTES = 30;
const HEAD_CHARS = 8192; // 6 KB of the file: every header we read is in it
const TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/flac'];
const TOO_BIG = `That recording is too big. Receipt reads up to ${MAX_MINUTES} minutes (8 MB) at a time.`;

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true, field: 'audio' });
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

/** Seconds of a PCM WAV from its header (`total` is the whole file's size),
 *  or null when it cannot be told from the head. */
function wavSeconds(head, total) {
  let at = 12;
  let rate = 0;
  while (at + 8 <= head.length) {
    const id = head.slice(at, at + 4).toString('latin1');
    const size = head.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 20 <= head.length) rate = head.readUInt32LE(at + 16); // byte rate
    if (id === 'data') return rate > 0 ? Math.min(size, Math.max(0, total - at - 8)) / rate : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

/**
 * @param raw  { type, data } where data is base64 or a data: URL
 * @returns    { mediaType, data, bytes } ready to go inline to the model
 */
function validate(raw) {
  if (!raw || typeof raw !== 'object') throw httpError(400, 'Record the meeting first.');
  let data = typeof raw.data === 'string' ? raw.data : '';
  // Size from the length first: a huge string is refused before any pattern
  // runs over it.
  if (data.length > Math.ceil(MAX_BYTES * 4 / 3) + 256) throw httpError(400, TOO_BIG);
  const m = data.slice(0, 128).match(/^data:([a-z0-9/+.;=\s-]+);base64,/i);
  if (m) data = data.slice(m[0].length);
  if (/\s/.test(data)) data = data.replace(/\s+/g, '');
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw httpError(400, 'That recording could not be read. Try recording it again.');
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const bytes = Math.floor(data.length * 3 / 4) - pad;
  if (bytes <= 0) throw httpError(400, 'That recording is empty.');
  if (bytes > MAX_BYTES) throw httpError(400, TOO_BIG);
  const head = Buffer.from(data.slice(0, HEAD_CHARS), 'base64');
  const actual = sniff(head);
  if (!actual) throw httpError(400, 'The recording must be a sound file (a phone recording, MP3, M4A, WAV or OGG).');
  if (actual === 'audio/wav') {
    const secs = wavSeconds(head, bytes);
    if (secs !== null && secs > MAX_MINUTES * 60 + 1) throw httpError(400, `That recording is longer than ${MAX_MINUTES} minutes. Trim it, or send it in two parts.`);
  }
  return { mediaType: actual, data, bytes };
}

module.exports = { validate, sniff, wavSeconds, MAX_BYTES, MAX_MINUTES, TYPES };
