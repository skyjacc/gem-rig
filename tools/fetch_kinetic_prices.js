const fs = require('fs');

async function getPrices() {
  console.log('Fetching market.dota2.net prices...');
  const res = await fetch('https://market.dota2.net/api/v2/prices/RUB.json');
  console.log('Status:', res.status);
  const data = await res.json();
  if (!data.success) {
    console.log('Error:', data);
    return;
  }
  console.log('Total items in market price database:', data.items.length);
  
  // Load our 113 mapped kinetic gems
  const kinetics = JSON.parse(fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/kinetic_names_mapped.json', 'utf8')).filter(k => k.market_name);
  
  const priceMap = new Map();
  for (const item of data.items) {
    priceMap.set(item.market_hash_name, { price: Number(item.price), count: Number(item.count) });
  }
  
  const ratedGems = [];
  for (const k of kinetics) {
    const market = priceMap.get(k.market_name);
    ratedGems.push({
      id: k.id,
      code: k.code_name,
      name: k.market_name,
      price: market ? market.price : null,
      listings: market ? market.count : 0
    });
  }
  
  // Sort by price desc
  ratedGems.sort((a, b) => (b.price || 0) - (a.price || 0));
  
  console.log('\n=== TOP KINETIC GEMS BY PRICE (RUB) ===');
  ratedGems.filter(g => g.price).slice(0, 30).forEach((g, idx) => {
    console.log(`${idx + 1}. ${g.name} — ${g.price} ₽ (лотов: ${g.listings})`);
  });
  
  fs.writeFileSync('C:/Users/oblako/Desktop/gem-rig/tools/kinetic_prices.json', JSON.stringify(ratedGems, null, 2));
}

getPrices().catch(e => console.error(e));
