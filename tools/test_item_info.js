const fs = require('fs');

async function testItemInfo() {
  const key = fs.readFileSync('C:/Users/oblako/Desktop/gem-rig/tools/market.key', 'utf8').trim();
  const classId = 57939624;
  const instanceId = 4506577821;
  
  const url = `https://market.dota2.net/api/v2/item-info/${classId}_${instanceId}?key=${key}`;
  console.log('Fetching:', url);
  const res = await fetch(url);
  const data = await res.json();
  console.log('Item info response:');
  console.log(JSON.stringify(data, null, 2));
}

testItemInfo().catch(e => console.error(e));
