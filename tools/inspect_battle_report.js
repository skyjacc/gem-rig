const fs = require('fs');
const path = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/bin/win64/client.dll';

const buf = fs.readFileSync(path);
const str = buf.toString('latin1');

const idx = str.indexOf('CMsgBattleReportAggregateStats');
if (idx !== -1) {
  const slice = str.substring(Math.max(0, idx - 50), Math.min(str.length, idx + 1200));
  console.log(slice.match(/[\x20-\x7E]{2,}/g).slice(0, 50));
}
