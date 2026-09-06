const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

// Find all occurrences of courier_grillhound_ambient
let idx = 0;
while ((idx = text.indexOf('courier_grillhound_ambient', idx)) !== -1) {
  console.log('--- Occurrence at', idx);
  console.log(text.substring(Math.max(0, idx - 200), Math.min(text.length, idx + 500)));
  idx += 'courier_grillhound_ambient'.length;
}
