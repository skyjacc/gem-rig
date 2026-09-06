const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);

const f = tree.files.find(x => x.path === 'particles/econ/courier/courier_wyrmeleon/courier_wrymeleon_ambient.vpcf_c');
const buf = vpk.readFile(vpkPath, tree.buf, f);
// Let's decode KV3 binary if possible or print chunks around m_flInputMax
const str = buf.toString('latin1');
const idx = str.indexOf('m_flInputMax');
if (idx !== -1) {
  console.log('Context around m_flInputMax:');
  console.log(str.substring(Math.max(0, idx - 100), Math.min(str.length, idx + 300)));
}
// Also print all tokens
const tokens = str.match(/[\x20-\x7E]{3,}/g);
console.log('All tokens:');
console.log(tokens);
