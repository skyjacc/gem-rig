const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

const queries = ['Fireborn', 'Bladekeeper', 'Kinetic Gem', 'kinetic'];

for (const q of queries) {
  let idx = 0;
  let count = 0;
  while ((idx = text.indexOf(q, idx)) !== -1) {
    if (count < 3) {
      console.log(`=== Query "${q}" at ${idx} ===`);
      console.log(text.substring(Math.max(0, idx - 100), Math.min(text.length, idx + 400)));
    }
    count++;
    idx += q.length;
  }
  console.log(`Query "${q}": total ${count}`);
}
