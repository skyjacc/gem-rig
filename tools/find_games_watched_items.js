const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

// Search for "games_watched" in items_game.txt
const matches = [];
let idx = 0;
while ((idx = text.indexOf('games_watched', idx)) !== -1) {
  matches.push(idx);
  idx += 'games_watched'.length;
}

console.log('Total "games_watched" occurrences in items_game.txt:', matches.length);

for (const m of matches.slice(0, 5)) {
  console.log('--- Occurrence at', m);
  console.log(text.substring(Math.max(0, m - 150), Math.min(text.length, m + 300)));
}
