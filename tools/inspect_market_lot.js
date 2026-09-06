const fs = require('fs');

async function testLot() {
  const key = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/market.key', 'utf8').trim();
  const itemName = 'Fireborn Odachi';
  
  const url = `https://market.dota2.net/api/v2/search-item-by-hash-name?key=${key}&hash_name=${encodeURIComponent(itemName)}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log('Lot 0 full object:');
  console.log(JSON.stringify(data.data[0], null, 2));
}

testLot().catch(e => console.error(e));
