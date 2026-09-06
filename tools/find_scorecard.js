const fs = require('fs');
const path = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/bin/win64/client.dll';

const buf = fs.readFileSync(path);
const str = buf.toString('latin1');

const regex = /CMsg[A-Za-z0-9_]*Scorecard[A-Za-z0-9_]*/g;
const matches = [...new Set(str.match(regex) || [])];
console.log('Scorecard matches:', matches);

for (const m of matches) {
  const idx = str.indexOf(m);
  console.log(`\n=== Match ${m} at ${idx} ===`);
  const slice = str.substring(Math.max(0, idx - 50), Math.min(str.length, idx + 800));
  console.log((slice.match(/[\x20-\x7E]{2,}/g) || []).slice(0, 35));
}
