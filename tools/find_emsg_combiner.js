const fs = require('fs');
const path = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/bin/win64/client.dll';

const buf = fs.readFileSync(path);
const str = buf.toString('latin1');

const target = 'ApplyGemCombiner';
let idx = 0;
while ((idx = str.indexOf(target, idx)) !== -1) {
  console.log('--- Match at offset:', idx);
  const slice = str.substring(Math.max(0, idx - 100), Math.min(str.length, idx + 200));
  console.log(slice.match(/[\x20-\x7E]{3,}/g));
  idx += target.length;
}
