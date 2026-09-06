const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

const idx = text.indexOf('"kill_eater_score_types"');
const end = text.indexOf('}\n\t"item_levels"', idx);
const section = text.substring(idx, end !== -1 ? end : idx + 30000);

const lines = section.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('type_name') || lines[i].includes('view') || lines[i].includes('game')) {
    console.log(lines[i].trim());
  }
}
