const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);

for (const name of ['courier_grillhound_ambient_single.vpcf_c', 'courier_grillhound_ambient_feet.vpcf_c', 'courier_grillhound_ambient_tail.vpcf_c']) {
  const file = tree.files.find(f => f.path.endsWith(name));
  if (!file) continue;
  const buf = vpk.readFile(vpkPath, tree.buf, file);
  const str = buf.toString('latin1');
  const matches = str.match(/[\x20-\x7E]{4,}/g) || [];
  console.log('=== File:', name, '===');
  console.log(matches.filter(m => !m.startsWith('materials/') && !m.startsWith('particles/')).slice(0, 40));
}
