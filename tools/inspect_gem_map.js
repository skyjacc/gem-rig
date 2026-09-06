const fs = require('fs');
const path = 'C:/Users/oblako/Desktop/gem-rig/tools/gem-map.json';

const data = JSON.parse(fs.readFileSync(path, 'utf8'));
console.log('Total entries in gem-map.json:', data.length);

const players = data.filter(d => d.kind === 'player');
console.log('Players in gem-map:', players.length);
players.slice(0, 20).forEach(p => console.log(`${p.name} -> entity_id: ${p.entity_id}`));

const teams = data.filter(d => d.kind === 'team');
console.log('\nTeams in gem-map:', teams.length);
teams.slice(0, 15).forEach(t => console.log(`${t.name} -> entity_id: ${t.entity_id}`));
