// ids — собирает пары «match_id,league_id» из OpenDota под конкретную лигу или команду.
//
//   node ids.js team 36 --out navi.csv
//   node ids.js league 19944 --out epl.csv
//   node ids.js pro --out pro.csv
//
// Пиши через --out, а не через > : PowerShell 5.1 при перенаправлении сохраняет
// файл в UTF-16, и его потом приходится распознавать по BOM.
//
// Пара match_id + league_id — ровно то, что клиент шлёт в CMsgUpgradeLeagueItem (7203).

const fs = require('fs');

const argv = process.argv.slice(2);
const [kind, id] = argv;
const outFile = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;

const URLS = {
  league: `https://api.opendota.com/api/leagues/${id}/matches`,
  team: `https://api.opendota.com/api/teams/${id}/matches`,
  pro: 'https://api.opendota.com/api/proMatches',
};

async function main() {
  const url = URLS[kind];
  if (!url) { console.error('использование: node ids.js league|team|pro [id] [--out файл]'); process.exit(1); }

  const res = await fetch(url, { headers: { 'User-Agent': 'gcwatch' } });
  if (!res.ok) throw new Error(`OpenDota ответил ${res.status}`);
  const rows = await res.json();

  const out = rows.filter(r => r.match_id).map(r => `${r.match_id},${r.leagueid || r.league_id || ''}`);
  console.error(`получено ${out.length} матчей`);

  if (outFile) {
    fs.writeFileSync(outFile, out.join(String.fromCharCode(10)), 'utf8');
    console.error(`записано в ${outFile}`);
  } else {
    for (const line of out) console.log(line);
  }
}

main().catch(e => { console.error('ошибка:', e.message); process.exit(1); });
