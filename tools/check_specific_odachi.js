const fs = require('fs');

async function check() {
  const steamKey = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/steam.key', 'utf8').trim();
  const classId = '507059515';
  const instanceId = '3402339528';
  
  const url = 'https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v0001?key=' + steamKey + '&appid=570&class_count=1&classid0=' + classId + '&instanceid0=' + instanceId;
  const res = await fetch(url);
  const data = await res.json();
  const obj = data.result && data.result[classId + '_' + instanceId];
  
  console.log('=== STEAM OFFICIAL RESULT ===');
  if (!obj) {
    console.log('Not found or null:', data);
    return;
  }
  console.log('Name:', obj.name);
  console.log('Market Hash Name:', obj.market_hash_name);
  console.log('Type:', obj.type);
  console.log('\nDescriptions:');
  for (const k in obj.descriptions) {
    console.log(`[${k}]`, obj.descriptions[k].value);
  }
}

check().catch(e => console.error(e));
