const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

// Search for "games watched" or "views" in attributes block
const attrStart = text.indexOf('"attributes"');
const attrEnd = text.indexOf('"items"', attrStart);
const attrSection = text.substring(attrStart, attrEnd);

const lines = attrSection.split('\n');
let currentAttr = null;
const found = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const m = line.match(/"(\d+)"/);
  if (m && lines[i+1] && lines[i+1].includes('{')) {
    currentAttr = m[1];
  }
  if (line.includes('games_watched') || line.includes('view') || line.includes('spectator') || line.includes('league')) {
    found.push({ attr: currentAttr, line: line.trim(), context: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 8)).join('\n') });
  }
}

console.log('Total matches found in attributes:', found.length);
found.slice(0, 15).forEach(f => {
  console.log('--- Attr:', f.attr);
  console.log(f.context);
});
