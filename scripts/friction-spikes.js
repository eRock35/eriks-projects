#!/usr/bin/env node
/**
 * What Friction is hearing, for the Challenge Lab's daily idea step.
 *
 * The daily run happens in a sandbox that cannot reach friction's web address,
 * so it reads Friction's Firestore database directly over REST with the
 * deploy token (/tmp/gcpdeploy/token, minted by `gcpdeploy auth`) and applies
 * Friction's OWN rules from apps/friction/lib/pulse.js - the same spike and
 * trend maths the board draws, not a second opinion.
 *
 *   node scripts/friction-spikes.js            # JSON: spiking, rising, strongest
 *   node scripts/friction-spikes.js --text     # the same, readable
 *
 * Read-only. Passed problems are left out: Erik already said no to them.
 */
const fs = require('fs');
const path = require('path');
const pulse = require('../apps/friction/lib/pulse.js');

const PROJECT = 'metal-celerity-236019';
const DB = 'friction';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DB}/documents`;

function value(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(value);
  if ('mapValue' in v) return fields(v.mapValue.fields || {});
  return null;
}
function fields(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) out[k] = value(v);
  return out;
}

async function listSignals(token) {
  const all = [];
  let pageToken = '';
  do {
    const url = `${BASE}/signals?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Firestore ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    for (const doc of d.documents || []) all.push({ id: doc.name.split('/').pop(), ...fields(doc.fields) });
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return all;
}

async function main() {
  const tokenFile = process.env.GCP_TOKEN_FILE || '/tmp/gcpdeploy/token';
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const now = new Date();
  const live = (await listSignals(token)).filter((s) => s.status !== 'passed');
  const rows = live.map((s) => {
    const p = pulse.annotate(s, now);
    return {
      id: s.id,
      title: s.title || '',
      summary: s.summary || s.problem || '',
      audience: s.audience || s.who || '',
      score: typeof s.score === 'number' ? s.score : null,
      seenCount: s.seenCount || 0,
      status: s.status || 'new',
      trend: p.trend,
      spike: p.spike,
      hint: pulse.appHint(s),
    };
  });
  const spiking = rows.filter((r) => r.spike && r.spike.spiking).sort((a, b) => b.spike.ratio - a.spike.ratio);
  const rising = rows.filter((r) => !(r.spike && r.spike.spiking) && r.trend && r.trend.dir === 'up')
    .sort((a, b) => (b.spike ? b.spike.sightingsThisWeek : 0) - (a.spike ? a.spike.sightingsThisWeek : 0)).slice(0, 5);
  const strongest = rows.slice().sort((a, b) => (b.score || 0) - (a.score || 0) || b.seenCount - a.seenCount).slice(0, 5);
  const out = { asOf: now.toISOString(), problems: rows.length, spiking, rising, strongest };

  if (process.argv.includes('--text')) {
    const line = (r) => `- ${r.title} (score ${r.score ?? '?'}, seen ${r.seenCount}x${r.spike && r.spike.spiking ? `, SPIKE x${r.spike.ratio}` : ''})\n    ${r.hint}`;
    console.log(`Friction, ${out.problems} open problems, as of ${out.asOf}`);
    console.log(`\nSpiking (${spiking.length}):\n${spiking.map(line).join('\n') || '  none this week'}`);
    console.log(`\nRising:\n${rising.map(line).join('\n') || '  none'}`);
    console.log(`\nStrongest:\n${strongest.map(line).join('\n') || '  none'}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch((e) => { console.error(`friction-spikes: ${e.message}`); process.exit(1); });
