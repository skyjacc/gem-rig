const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);

const files = [
  'particles/econ/courier/courier_grillhound/courier_grillhound_ambient.vpcf_c',
  'particles/econ/courier/courier_grillhound/courier_grillhound_ambient_feet.vpcf_c',
  'particles/econ/courier/courier_grillhound/courier_grillhound_ambient_tail.vpcf_c',
  'particles/econ/courier/courier_wyrmeleon/courier_wrymeleon_ambient.vpcf_c'
];

for (const fp of files) {
  const f = tree.files.find(x => x.path === fp);
  if (!f) continue;
  const buf = vpk.readFile(vpkPath, tree.buf, f);
  console.log(`=== ${fp} (${buf.length} bytes) ===`);
  const str = buf.toString('latin1');
  // Find all strings like C_OP_*, m_fl*, m_n*, etc.
  const ops = str.match(/C_OP_[a-zA-Z0-9_]+/g) || [];
  const props = str.match(/m_[a-zA-Z0-9_]+/g) || [];
  console.log('Operators:', [...new Set(ops)]);
  console.log('Key properties:', [...new Set(props)].slice(0, 30));
}
