const fs = require('fs');
const path = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/bin/win64/client.dll';

const buf = fs.readFileSync(path);

function readVarint(buffer, offset) {
  let res = 0;
  let shift = 0;
  let o = offset;
  while (o < buffer.length) {
    const b = buffer[o++];
    res |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { val: res, bytes: o - offset };
}

const results = [];
const marker = Buffer.from('k_EMsg');

let o = 0;
while (o < buf.length - 30) {
  const idx = buf.indexOf(marker, o);
  if (idx === -1) break;
  
  // Tag 0x0a and length should be right before idx
  // Let's check 1 or 2 bytes before idx
  if (idx > 2 && buf[idx - 2] === 0x0a) {
    const len = buf[idx - 1];
    const name = buf.subarray(idx, idx + len).toString('ascii');
    // After name, should be tag 0x10 (number)
    const after = idx + len;
    if (buf[after] === 0x10) {
      const { val } = readVarint(buf, after + 1);
      results.push({ name, id: val });
    }
  } else if (idx > 1 && buf[idx - 1] < 128) {
    const len = buf[idx - 1];
    const name = buf.subarray(idx, idx + len).toString('ascii');
    const after = idx + len;
    if (buf[after] === 0x10) {
      const { val } = readVarint(buf, after + 1);
      results.push({ name, id: val });
    }
  }
  o = idx + 6;
}

console.log('Total extracted:', results.length);
const unique = [];
const seen = new Set();
for (const r of results) {
  if (!seen.has(r.name)) {
    seen.add(r.name);
    unique.push(r);
  }
}
unique.sort((a, b) => a.id - b.id);
fs.writeFileSync('C:/Users/oblako/Desktop/gem-rig/tools/extracted_emsg.json', JSON.stringify(unique, null, 2));

console.log('Unique EMsg:', unique.length);

console.log('\n--- Spectator / League / Gem EMsg: ---');
console.log(unique.filter(r => /spectat|gem|league|replay|watch/i.test(r.name)));

console.log('\n--- Dev / Admin / Test / Cheat EMsg: ---');
console.log(unique.filter(r => /dev|admin|test|debug|cheat|grant/i.test(r.name)));

console.log('\n--- Econ / Craft / Socket / Item EMsg: ---');
console.log(unique.filter(r => /craft|socket|econ|item|recipe|modify|apply/i.test(r.name)).slice(0, 40));
