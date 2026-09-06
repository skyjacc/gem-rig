const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

// Find all items with "Kinetic" in their name or item_type_name
const regex = /"(\d+)"\s*\{\s*"name"\s*"Kinetic:\s*([^"]+)"/g;
let m;
const kinetics = [];

while ((m = regex.exec(text)) !== null) {
  const id = m[1];
  const name = m[2];
  // extract chunk to see hero / anim
  const chunk = text.substring(m.index, m.index + 800);
  kinetics.push({ id, name, chunk: chunk.substring(0, 300) });
}

console.log('Total Kinetic Gems found:', kinetics.length);
kinetics.forEach(k => console.log(`[${k.id}] Kinetic: ${k.name}`));
