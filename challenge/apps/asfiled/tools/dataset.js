// The published dataset, read back from its parts (public/data/index.json,
// patterns.json and c/<ID>.json) and merged into one object, the same way
// the page merges them as it loads them. Used by the verifier and the tests.

const fs = require('fs');
const path = require('path');
const Core = require('../public/asfiled-core');

const DIR = path.join(__dirname, '..', 'public', 'data');
const read = (rel, dir) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

function load(dir = DIR) {
  const index = read('index.json', dir);
  const data = Core.start(index);
  Core.merge(data, read('patterns.json', dir));
  for (const c of index.companies) Core.merge(data, read(`c/${c.id}.json`, dir));
  // The full figure and filing sets are the union of the parts.
  return data;
}

module.exports = { DIR, load };
