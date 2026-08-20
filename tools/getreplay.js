// getreplay — тянет реплеи Dota 2 с серверов Valve прямо в папку реплеев клиента.
//
//   node tools/getreplay.js 8942262723 [ещё id...]
//   node tools/getreplay.js --team 36 --count 5
//   node tools/getreplay.js --league 19944 --count 5
//   node tools/getreplay.js --out "путь\к\replays" 8942262723
//
// salt и cluster берутся из OpenDota, файл лежит по адресу
//   http://replay<cluster>.valve.net/570/<match_id>_<salt>.dem.bz2
// Расширение осталось .bz2 с прошлых лет, внутри сейчас zstd — распаковка определяется
// по сигнатуре, а не по имени. Реплеи живут на серверах Valve ограниченное время,
// у старых матчей salt приходит null и скачать уже нечего.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_OUT = 'D:/SteamLibrary/steamapps/common/dota 2 beta/game/dota/replays';
const UA = 'getreplay';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = opt('--out', DEFAULT_OUT);
const COUNT = Number(opt('--count', 5));

async function api(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`OpenDota ${res.status} на ${url}`);
  return res.json();
}

async function idsFromArgs() {
  const team = opt('--team', null), league = opt('--league', null);
  if (team) return (await api(`https://api.opendota.com/api/teams/${team}/matches`)).slice(0, COUNT).map(m => m.match_id);
  if (league) return (await api(`https://api.opendota.com/api/leagues/${league}/matches`)).slice(0, COUNT).map(m => m.match_id);
  return argv.filter(a => /^\d{6,}$/.test(a)).map(Number);
}

function decompressor(head) {
  if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) {
    if (!zlib.createZstdDecompress) throw new Error('файл в zstd, а этот Node его не умеет — нужен Node 22.15+');
    return zlib.createZstdDecompress();
  }
  if (head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68) throw new Error('файл в bzip2, распакуй вручную');
  return null; // уже .dem
}

async function pull(matchId) {
  const m = await api(`https://api.opendota.com/api/matches/${matchId}`);
  if (!m.replay_salt || !m.cluster) return console.log(`  ${matchId}: реплея нет (salt пустой) — матч слишком старый`);

  const url = `http://replay${m.cluster}.valve.net/570/${matchId}_${m.replay_salt}.dem.bz2`;
  const res = await fetch(url);
  if (!res.ok) return console.log(`  ${matchId}: Valve ответил ${res.status}`);

  const raw = Buffer.from(await res.arrayBuffer());
  const dst = path.join(OUT, `${matchId}.dem`);
  const dec = decompressor(raw);

  if (!dec) fs.writeFileSync(dst, raw);
  else await new Promise((ok, err) => {
    const out = fs.createWriteStream(dst);
    dec.on('error', err); out.on('error', err); out.on('finish', ok);
    dec.end(raw); dec.pipe(out);
  });

  const head = Buffer.alloc(8);
  const fd = fs.openSync(dst, 'r'); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
  const magic = head.toString('latin1', 0, 7);
  const size = (fs.statSync(dst).size / 1048576).toFixed(1);
  console.log(`  ${matchId}: ${size} МБ, сигнатура ${magic}${magic === 'PBDEMS2' ? '' : ' — не похоже на демо Source 2'}`);
}

async function main() {
  const ids = await idsFromArgs();
  if (!ids.length) { console.error('нечего качать. Передай match_id или --team / --league'); process.exit(1); }
  if (!fs.existsSync(OUT)) { console.error(`нет папки ${OUT} — укажи --out`); process.exit(1); }
  console.log(`качаю ${ids.length} реплеев в ${OUT}`);
  for (const id of ids) {
    try { await pull(id); } catch (e) { console.log(`  ${id}: ${e.message}`); }
  }
  console.log('в клиенте: playdemo replays/<match_id>');
}

main().catch(e => { console.error('ошибка:', e.message); process.exit(1); });
