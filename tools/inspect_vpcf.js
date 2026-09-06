const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const file = tree.files.find(f => f.path === 'particles/econ/courier/courier_grillhound/courier_grillhound_ambient.vpcf_c');
const buf = vpk.readFile(vpkPath, tree.buf, file);
console.log('Buffer length:', buf.length);
// KV3 can be binary or text. Let's check signature.
console.log('Signature:', buf.subarray(0, 16).toString('latin1'));
// Let's print printable strings
const str = buf.toString('latin1');
const matches = str.match(/[\x20-\x7E]{4,}/g);
console.log('Strings found:', matches ? matches.slice(0, 50) : []);
