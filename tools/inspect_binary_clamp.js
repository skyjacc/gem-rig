const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);

const f = tree.files.find(x => x.path === 'particles/econ/courier/courier_wyrmeleon/courier_wrymeleon_ambient.vpcf_c');
const buf = vpk.readFile(vpkPath, tree.buf, f);

const idx = buf.indexOf('m_flInputMax');
console.log('Offset of m_flInputMax:', idx);

// In KV3 binary, let's examine bytes around idx
const start = Math.max(0, idx - 64);
const end = Math.min(buf.length, idx + 128);
console.log('Hex dump:');
console.log(buf.subarray(start, end).toString('hex'));

// Let's read floats in this range
for (let o = start; o < end - 4; o += 2) {
  const fl = buf.readFloatLE(o);
  const u32 = buf.readUInt32LE(o);
  if ((fl >= 1 && fl <= 100000) || u32 === 100 || u32 === 1000 || fl === 100 || fl === 1000) {
    console.log(`At offset ${o} (rel ${o - idx}): float=${fl}, u32=${u32}`);
  }
}
