const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

const queries = ['Games Watched', 'games watched', 'views', 'view_count', 'spectator', 'league'];

for (const q of queries) {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(q, idx)) !== -1) {
    count++;
    idx += q.length;
  }
  console.log(`Query "${q}": ${count} matches`);
}

// Find first occurrence of "Games Watched" case-insensitive
const regex = /games\s*watched/i;
const m = regex.exec(text);
if (m) {
  console.log('Found match:', m.index);
  console.log(text.substring(Math.max(0, m.index - 100), Math.min(text.length, m.index + 200)));
} else {
  console.log('No games watched found directly in items_game');
}
