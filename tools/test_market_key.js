const fs = require('fs');

async function testMarket() {
  const key = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/market.key', 'utf8').trim();
  console.log('Using Market key:', key.substring(0, 5) + '...');
  
  // Test market.dota2.net API: get-money or prices
  const url = `https://market.dota2.net/api/v2/get-money?key=${key}`;
  const res = await fetch(url);
  console.log('Status:', res.status);
  const data = await res.json();
  console.log('Balance response:', data);
}

testMarket().catch(e => console.error(e));
