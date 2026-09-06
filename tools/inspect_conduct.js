const fs = require('fs');
const path = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/bin/win64/client.dll';

const buf = fs.readFileSync(path);
const str = buf.toString('latin1');

const target = 'CMsgClientToGCLatestConductScorecard';
let idx = 0;
while ((idx = str.indexOf(target, idx)) !== -1) {
  console.log(`\n=== Offset ${idx} ===`);
  const slice = str.substring(Math.max(0, idx - 50), Math.min(str.length, idx + 1200));
  const tokens = slice.match(/[\x20-\x7E]{2,}/g) || [];
  console.log(tokens.slice(0, 50));
  idx += target.length;
}
