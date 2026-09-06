const fs = require('fs');

async function scanItem(itemName) {
  const marketKey = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/market.key', 'utf8').trim();
  const steamKey = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/steam.key', 'utf8').trim();
  
  console.log(`Scanning lots for "${itemName}" on market.dota2.net...`);
  const res = await fetch(`https://market.dota2.net/api/v2/search-item-by-hash-name?key=${marketKey}&hash_name=${encodeURIComponent(itemName)}`);
  const data = await res.json();
  if (!data.success || !data.data) {
    console.log('Error fetching lots:', data);
    return;
  }
  
  const lots = data.data;
  console.log(`Found ${lots.length} active lots for "${itemName}"`);
  
  // Group unique class + instance
  const pairs = [];
  for (const l of lots) {
    if (!pairs.some(p => p.classid === String(l.class) && p.instanceid === String(l.instance))) {
      pairs.push({ classid: String(l.class), instanceid: String(l.instance) });
    }
  }
  
  console.log(`Resolving ${pairs.length} unique asset variants via Steam API...`);
  
  // Batch Steam GetAssetClassInfo up to 50 at a time
  let url = `https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v0001?key=${steamKey}&appid=570&class_count=${pairs.length}`;
  for (let i = 0; i < pairs.length; i++) {
    url += `&classid${i}=${pairs[i].classid}&instanceid${i}=${pairs[i].instanceid}`;
  }
  
  const sRes = await fetch(url);
  const sData = await sRes.json();
  const resultMap = sData.result || {};
  
  console.log('\n--- SCAN RESULTS ---');
  for (const lot of lots) {
    const priceRub = lot.price / 100;
    const key = `${lot.class}_${lot.instance}`;
    const info = resultMap[key];
    if (!info) continue;
    
    // Find gems in descriptions
    const gems = [];
    for (const dKey in info.descriptions) {
      const val = info.descriptions[dKey].value || '';
      if (val.includes('Kinetic') || val.includes('Кинетический')) {
        const clean = val.replace(/<[^>]+>/g, '|').split('|').map(s => s.trim()).filter(Boolean);
        gems.push(clean.join(' '));
      }
    }
    
    if (gems.length) {
      console.log(`[PROFIT MATCH!] Price: ${priceRub} ₽ | GEMS: ${gems.join(', ')}`);
    } else {
      console.log(`- Price: ${priceRub} ₽ | [Empty / No Kinetic]`);
    }
  }
}

scanItem('Fireborn Odachi').catch(e => console.error(e));
