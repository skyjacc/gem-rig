const fs = require('fs');
const path = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/bin/win64/client.dll';

console.log('Reading client.dll...');
const buf = fs.readFileSync(path);
console.log('client.dll size:', buf.length);

const str = buf.toString('latin1');

// Match k_EMsgGC* and k_EMsgClientToGC*
const emsgMatches = str.match(/k_EMsg[A-Za-z0-9_]+/g) || [];
const uniqueEmsg = [...new Set(emsgMatches)].sort();
console.log('Total unique k_EMsg*: ', uniqueEmsg.length);

// Match CMsgGC* and CMsgClientToGC* and CMsgDOTA*
const cmsgMatches = str.match(/CMsg(?:GC|ClientToGC|DOTA)[A-Za-z0-9_]+/g) || [];
const uniqueCmsg = [...new Set(cmsgMatches)].sort();
console.log('Total unique CMsg*: ', uniqueCmsg.length);

// Let's filter interesting categories:
// 1. Spectator / League / Views / Gems
const spec = uniqueCmsg.filter(m => /spectat|league|view|gem|watch/i.test(m));
console.log('\n=== Spectator / League / Gem Messages ===');
console.log(spec);

// 2. Inventory / Econ / Craft / Socket
const econ = uniqueCmsg.filter(m => /econ|craft|socket|item|customiz|unpack/i.test(m));
console.log('\n=== Econ / Inventory Messages ===');
console.log(econ.slice(0, 30));

// 3. Profile / Stats / Matchmaking / Hidden
const profile = uniqueCmsg.filter(m => /profile|stat|dev|debug|test|admin|cheat/i.test(m));
console.log('\n=== Profile / Debug / Hidden Stats Messages ===');
console.log(profile.slice(0, 40));
