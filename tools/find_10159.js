const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

// Find all occurrences of 10159
let idx = 0;
while ((idx = text.indexOf('10159', idx)) !== -1) {
  console.log('--- 10159 at index:', idx);
  console.log(text.substring(Math.max(0, idx - 100), Math.min(text.length, idx + 200)));
  idx += '10159'.length;
}
