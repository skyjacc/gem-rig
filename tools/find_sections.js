const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

const sections = ['kill_eater_score_types', 'gem_types', 'socket_gem', 'spectator_gems', 'league_flags'];

for (const s of sections) {
  const idx = text.indexOf(`"${s}"`);
  console.log(`Section "${s}": ${idx !== -1 ? 'FOUND at ' + idx : 'NOT FOUND'}`);
  if (idx !== -1) {
    console.log(text.substring(idx, idx + 1000));
  }
}
