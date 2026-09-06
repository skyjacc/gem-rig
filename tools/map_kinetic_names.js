const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const file = tree.files.find(f => f.path === 'resource/localization/dota_english.txt');
const buf = vpk.readFile(vpkPath, tree.buf, file);
// VPK localization files can be UTF-8 or UCS-2 (UTF-16LE)
let text = '';
if (buf[0] === 0xff && buf[1] === 0xfe) {
  text = buf.subarray(2).toString('utf16le');
} else {
  text = buf.toString('utf8');
}

console.log('dota_english length:', text.length);

const kinetics = JSON.parse(fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/all_kinetic_gems.json', 'utf8'));

const mapped = [];
for (const k of kinetics) {
  const locKey = k.loc.replace(/^#/, '');
  // Find "locKey" in text
  const regex = new RegExp(`"${locKey}"\\s*"([^"]+)"`, 'i');
  const m = text.match(regex);
  if (m) {
    mapped.push({ id: k.id, code_name: k.name, market_name: `Kinetic: ${m[1]}`, raw_title: m[1] });
  } else {
    mapped.push({ id: k.id, code_name: k.name, market_name: null, raw_title: null });
  }
}

const found = mapped.filter(m => m.market_name);
console.log(`Mapped ${found.length} / ${kinetics.length} kinetic gems!`);
fs.writeFileSync('C:/Users/oblako/Desktop/gem-rig/tools/kinetic_names_mapped.json', JSON.stringify(mapped, null, 2));

console.log('Sample found gems:');
found.slice(0, 25).forEach(f => console.log(`${f.code_name} => "${f.market_name}"`));
