const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

const startIdx = text.indexOf('"asset_modifiers"');
const endIdx = text.indexOf('}\n\t"attribute_controlled_attached_particles"', startIdx);
const section = text.substring(startIdx, endIdx !== -1 ? endIdx : startIdx + 50000);

// Parse all items in asset_modifiers
const regex = /"(\d+)"\s*\{\s*"name"\s*"([^"]+)"\s*"loc_key"\s*"([^"]+)"/g;
let m;
const gems = [];
while ((m = regex.exec(section)) !== null) {
  gems.push({ id: m[1], name: m[2], loc: m[3] });
}

console.log('Total Kinetic modifiers found in schema:', gems.length);
fs.writeFileSync('C:/Users/oblako/Desktop/gem-rig/tools/all_kinetic_gems.json', JSON.stringify(gems, null, 2));

console.log(gems.slice(0, 30));
