const fs = require('fs');

async function testSteamClassInfo() {
  const steamKey = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/steam.key', 'utf8').trim();
  const classId = '57939624';
  const instanceId = '4506577821';
  
  const url = `https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v0001?key=${steamKey}&appid=570&class_count=1&classid0=${classId}&instanceid0=${instanceId}`;
  console.log('Fetching Steam Asset Info...');
  const res = await fetch(url);
  const data = await res.json();
  console.log('Result for class+instance:');
  const obj = data.result && data.result[classId + '_' + instanceId];
  if (obj) {
    console.log('Name:', obj.market_hash_name || obj.name);
    console.log('Descriptions:');
    for (const k in obj.descriptions) {
      console.log(' - ', obj.descriptions[k].value);
    }
  } else {
    console.log('Raw result:', data.result);
  }
}

testSteamClassInfo().catch(e => console.error(e));
