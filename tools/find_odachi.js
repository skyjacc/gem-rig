const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

const target = 'odachi';
let idx = 0;
while ((idx = text.toLowerCase().indexOf(target, idx)) !== -1) {
  console.log('--- Match at', idx);
  console.log(text.substring(Math.max(0, idx - 100), Math.min(text.length, idx + 400)));
  idx += target.length;
}
