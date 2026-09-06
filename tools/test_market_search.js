const fs = require('fs');

async function testSearch() {
  const key = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/market.key', 'utf8').trim();
  const itemName = 'Fireborn Odachi';
  
  const url = `https://market.dota2.net/api/v2/search-item-by-hash-name?key=${key}&hash_name=${encodeURIComponent(itemName)}`;
  console.log('Fetching:', url);
  const res = await fetch(url);
  console.log('Status:', res.status);
  const data = await res.json();
  console.log('Response success:', data.success);
  if (data.data) {
    console.log('Found lots:', data.data.length);
    for (const lot of data.data.slice(0, 5)) {
      console.log(`- ID: ${lot.id}, Price: ${lot.price / 100} ₽, extra:`, lot.extra);
    }
  } else {
    console.log('Data:', data);
  }
}

testSearch().catch(e => console.error(e));
