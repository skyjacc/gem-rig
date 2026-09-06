const fs = require('fs');
const path = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/bin/win64/client.dll';

const buf = fs.readFileSync(path);
const str = buf.toString('latin1');

const targets = [
  'CMsgClientToGCTeammateStatsRequest',
  'CMsgClientToGCTeammateStatsResponse',
  'CMsgClientToGCLatestConductScorecardRequest',
  'CMsgClientToGCLatestConductScorecard'
];

for (const t of targets) {
  let idx = 0;
  while ((idx = str.indexOf(t, idx)) !== -1) {
    console.log(`\n=== ${t} at ${idx} ===`);
    const slice = str.substring(Math.max(0, idx - 100), Math.min(str.length, idx + 800));
    const tokens = slice.match(/[\x20-\x7E]{2,}/g) || [];
    console.log(tokens.slice(0, 35));
    idx += t.length;
  }
}
