const vpk = require('./vpk.js');
const fs = require('fs');
const vpkPath = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/pak01_dir.vpk';
const tree = vpk.readVpkTree(vpkPath);
const files = tree.files.filter(f => f.path.includes('grillhound'));
console.log('Grillhound files:');
files.forEach(f => console.log(f.path));
