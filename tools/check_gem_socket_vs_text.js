const fs = require('fs');

async function testAllOdachiLots() {
  const steamKey = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/steam.key', 'utf8').trim();
  const marketKey = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/market.key', 'utf8').trim();
  
  const mRes = await fetch(`https://market.dota2.net/api/v2/search-item-by-hash-name?key=${marketKey}&hash_name=Fireborn%20Odachi`);
  const mData = await mRes.json();
  const lots = mData.data;
  
  const pairs = lots.map(l => ({ classid: String(l.class), instanceid: String(l.instance), price: l.price / 100 }));
  
  let url = `https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v0001?key=${steamKey}&appid=570&class_count=${pairs.length}`;
  for (let i = 0; i < pairs.length; i++) {
    url += `&classid${i}=${pairs[i].classid}&instanceid${i}=${pairs[i].instanceid}`;
  }
  
  const sRes = await fetch(url);
  const sData = await sRes.json();
  
  console.log(`Checking ${pairs.length} lots for PHYSICAL gem_animation socket...`);
  for (const p of pairs) {
    const info = sData.result[p.classid + '_' + p.instanceid];
    if (!info) continue;
    
    let hasPhysicalKineticSocket = false;
    let gemName = null;
    let hasTextKinetic = false;
    
    for (const k in info.descriptions) {
      const val = info.descriptions[k].value || '';
      if (val.includes('gem_animation')) {
        hasPhysicalKineticSocket = true;
        gemName = val.replace(/<[^>]+>/g, '|');
      }
      if (val.includes('Kinetic')) {
        hasTextKinetic = true;
      }
    }
    
    console.log(`Lot ${p.price} ₽ (${p.classid}_${p.instanceid}): physicalSocket=${hasPhysicalKineticSocket}, textMention=${hasTextKinetic}`);
  }
}

testAllOdachiLots().catch(e => console.error(e));
