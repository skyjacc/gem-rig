const fs = require('fs');
const path = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/bin/win64/client.dll';

const buf = fs.readFileSync(path);
const target = 'k_EMsgClientToGCApplyGemCombiner';
const idx = buf.indexOf(target);
console.log('Index:', idx);

// Look around for numbers
const start = Math.max(0, idx - 60);
const end = Math.min(buf.length, idx + 100);
console.log('Raw bytes around string:');
console.log(buf.subarray(start, end).toString('hex'));

// Let's also search where the pointer to this string is referenced in the .rdata / .data section
const ptrBuf = Buffer.alloc(8);
// Find all 4-byte or 8-byte references to idx
console.log('Searching references to offset:', idx);
