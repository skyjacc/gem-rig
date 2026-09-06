const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const itemsGameEntry = tree.files.find(f => f.path === 'scripts/items/items_game.txt');
const buf = vpk.readFile(vpkPath, tree.buf, itemsGameEntry);
const text = buf.toString('utf8');

const dotaLocFile = tree.files.find(f => f.path === 'resource/localization/dota_english.txt');
const locBuf = vpk.readFile(vpkPath, tree.buf, dotaLocFile);
const locText = (locBuf[0] === 0xff && locBuf[1] === 0xfe) ? locBuf.subarray(2).toString('utf16le') : locBuf.toString('utf8');

const kinetics = JSON.parse(fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/kinetic_names_mapped.json', 'utf8')).filter(k => k.market_name);

// Find in items_game.txt items that have asset_modifier pointing to this kinetic id or modifier
// In items_game:
// "asset_modifier" { "type" "activity" ... } or modifier: "<code_name>"
const itemParents = [];

for (const k of kinetics) {
  const code = k.code_name;
  // search for "modifier" "<code_name>" in "items" block
  const searchStr = `"${code}"`;
  let idx = 0;
  const hosts = [];
  while ((idx = text.indexOf(searchStr, idx)) !== -1) {
    // Make sure it is inside an item definition
    // Scan backwards to find the item defindex: "\d+" {
    const backSlice = text.substring(Math.max(0, idx - 1500), idx);
    const itemMatch = backSlice.match(/"(\d+)"\s*\{\s*"name"\s*"([^"]+)"/g);
    if (itemMatch) {
      const last = itemMatch[itemMatch.length - 1];
      const m = last.match(/"(\d+)"\s*\{\s*"name"\s*"([^"]+)"/);
      if (m && m[1] > 1000 && m[1] < 35000) {
        // Look up localized item name
        const itemDef = text.substring(idx - 1000, idx + 500);
        const itemLoc = itemDef.match(/"item_name"\s*"#([^"]+)"/);
        let niceName = m[2];
        if (itemLoc) {
          const reg = new RegExp(`"${itemLoc[1]}"\\s*"([^"]+)"`, 'i');
          const lm = locText.match(reg);
          if (lm) niceName = lm[1];
        }
        hosts.push({ defindex: m[1], internal_name: m[2], market_name: niceName });
      }
    }
    idx += searchStr.length;
  }
  
  const uniqueHosts = [];
  const seen = new Set();
  for (const h of hosts) {
    if (!seen.has(h.defindex)) {
      seen.add(h.defindex);
      uniqueHosts.push(h);
    }
  }
  if (uniqueHosts.length) {
    itemParents.push({ gem: k.market_name, code: k.code_name, hosts: uniqueHosts });
  }
}

console.log('Kinetic gems with identified host items:', itemParents.length);
fs.writeFileSync('C:/Users/oblako/Desktop/gem-rig/tools/kinetic_item_pairs.json', JSON.stringify(itemParents, null, 2));

itemParents.slice(0, 20).forEach(p => {
  console.log(`\nGem: ${p.gem}`);
  p.hosts.forEach(h => console.log(`  -> Host: [${h.defindex}] ${h.market_name}`));
});
