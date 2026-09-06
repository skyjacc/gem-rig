const fs = require('fs');

async function findRealGems() {
  const steamKey = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/steam.key', 'utf8').trim();
  const marketKey = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/market.key', 'utf8').trim();
  
  const targets = [
    'Pyre',
    'Diffusal Lance',
    'The One Horn',
    "Lyralei's Breeze",
    'Bladebiter',
    'Eye of Omoz',
    'Timberthaw Ripsaw'
  ];
  
  for (const item of targets) {
    const mRes = await fetch(`https://market.dota2.net/api/v2/search-item-by-hash-name?key=${marketKey}&hash_name=${encodeURIComponent(item)}`);
    const mData = await mRes.json();
    if (!mData.success || !mData.data || !mData.data.length) continue;
    
    const lots = mData.data.slice(0, 15);
    const pairs = lots.map(l => ({ classid: String(l.class), instanceid: String(l.instance), price: l.price / 100 }));
    
    let url = `https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v0001?key=${steamKey}&appid=570&class_count=${pairs.length}`;
    for (let i = 0; i < pairs.length; i++) {
      url += `&classid${i}=${pairs[i].classid}&instanceid${i}=${pairs[i].instanceid}`;
    }
    
    const sRes = await fetch(url);
    const sData = await sRes.json();
    
    for (const p of pairs) {
      const info = sData.result[p.classid + '_' + p.instanceid];
      if (!info) continue;
      for (const k in info.descriptions) {
        const val = info.descriptions[k].value || '';
        if (val.includes('gem_animation')) {
          console.log(`[REAL KINETIC FOUND!] Item: ${item}, Price: ${p.price} ₽, ClassInstance: ${p.classid}_${p.instanceid}`);
          // Extract gem name from HTML
          const match = val.match(/<span style="font-size: 18px[^>]*>([^<]+)<\/span>/);
          if (match) console.log(`  -> Real Gem Inside: "${match[1]}"`);
        }
      }
    }
  }
}

findRealGems().catch(e => console.error(e));
