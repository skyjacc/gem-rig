const fs = require('fs');
const path = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/bin/win64/client.dll';

const buf = fs.readFileSync(path);
const str = buf.toString('latin1');

const targets = [
  'CMsgClientToGCTeammateStatsRequest',
  'CMsgClientToGCTeammateStatsResponse',
  'CMsgClientToGCLatestConductScorecardRequest',
  'CMsgClientToGCLatestConductScorecard',
  'CMsgClientToGCGetBattleReportAggregateStats',
  'CMsgClientToGCGetBattleReportAggregateStatsResponse',
  'CMsgClientToGCApplyGemCombiner'
];

for (const t of targets) {
  console.log(`\n================== ${t} ==================`);
  let idx = 0;
  while ((idx = str.indexOf(t, idx)) !== -1) {
    // Check if this looks like a protobuf descriptor (starts with \n or length)
    const slice = str.substring(Math.max(0, idx - 50), Math.min(str.length, idx + 500));
    const tokens = slice.match(/[\x20-\x7E]{2,}/g) || [];
    console.log(`Offset ${idx}:`, tokens.slice(0, 25));
    idx += t.length;
  }
}
