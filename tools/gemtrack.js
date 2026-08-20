// gemtrack — снимок счётчиков на предметах Dota 2 из публичного инвентаря Steam.
//
//   node tools/gemtrack.js snap <steamid64> <label>   снять срез и сохранить
//   node tools/gemtrack.js diff <labelA> <labelB>     что изменилось между срезами
//   node tools/gemtrack.js watch <steamid64> <база> [сек] [мин]   ждать первого движения
//   node tools/gemtrack.js list                       список срезов
//   node tools/gemtrack.js csv                        все срезы одной таблицей
//
// Счётчик (Games Watched / Kills) — атрибут самого гема, уникален для экземпляра,
// поэтому сверка идёт по assetid. Гем и герой вытаскиваются из описания предмета,
// чтобы в журнале было видно, что именно тикнуло.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'gemtrack-data');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const COUNTERS = [
  [/Games\s*Watched:\s*([\d,\s]+)/i, 'games_watched'],
  [/Просмотрено\s+игр:\s*([\d,\s]+)/i, 'games_watched'],
  [/Kills:\s*([\d,\s]+)/i, 'kills'],
  [/Убийств:\s*([\d,\s]+)/i, 'kills'],
];

// Steam кеширует ответ инвентаря на несколько минут, поэтому счётчик в клиенте
// обновляется раньше, чем здесь. Меняющийся параметр сбивает кеш.
let bust = 0;
async function fetchInventory(steamid) {
  const url = `https://steamcommunity.com/inventory/${steamid}/570/2?l=english&count=2000&_=${process.pid}${bust++}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 403) throw new Error('инвентарь закрыт — Steam → Privacy Settings → Inventory: Public');
  if (res.status === 429) throw new Error('Steam ограничил частоту запросов, подождать пару минут');
  if (!res.ok) throw new Error(`Steam ответил ${res.status}`);
  const body = await res.json();
  if (!body || !body.assets) throw new Error('инвентарь пуст или ответ без assets');
  return body;
}

// Блок гема приходит вёрсткой: <div>...Team Empire...Games Watched: 1...</div>
function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\|+/g, '|');
}

function parseItem(desc) {
  const counters = {};
  let gem = '', hero = '';

  for (const d of desc.descriptions || []) {
    const raw = d.value || '';
    const text = stripTags(raw);

    const used = raw.match(/^Used By:\s*(.+)$/);
    if (used) hero = used[1].trim();

    for (const [re, key] of COUNTERS) {
      const m = text.match(re);
      if (!m) continue;
      counters[key] = Number(m[1].replace(/[\s,]/g, ''));
      // имя сущности гема — первый непустой кусок блока перед счётчиком
      const parts = text.split('|').map(s => s.trim()).filter(Boolean);
      const idx = parts.findIndex(p => re.test(p));
      if (idx > 0) gem = parts[idx - 1];
    }
  }
  return { counters, gem, hero };
}

function collect(body) {
  const byKey = new Map();
  for (const d of body.descriptions) byKey.set(`${d.classid}_${d.instanceid}`, d);

  const rows = [];
  for (const a of body.assets) {
    const d = byKey.get(`${a.classid}_${a.instanceid}`);
    if (!d) continue;
    const { counters, gem, hero } = parseItem(d);
    if (!Object.keys(counters).length) continue;
    rows.push({ assetid: a.assetid, name: d.market_hash_name || d.name, gem, hero, counters });
  }
  rows.sort((x, y) => (x.gem + x.name).localeCompare(y.gem + y.name));
  return rows;
}

const snapPath = label => path.join(DATA, `${label}.json`);

async function cmdSnap(steamid, label) {
  if (!/^\d{17}$/.test(steamid)) throw new Error('нужен steamID64 — 17 цифр');
  if (!label) throw new Error('нужна метка среза, например T0 или T1-after');
  const body = await fetchInventory(steamid);
  const rows = collect(body);
  const snap = { label, steamid, ts: new Date().toISOString(), total: body.total_inventory_count, rows };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(snapPath(label), JSON.stringify(snap, null, 2));

  console.log(`срез ${label}  ${snap.ts}  предметов: ${snap.total}  со счётчиком: ${rows.length}`);
  for (const r of rows) {
    const c = Object.entries(r.counters).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  ${(r.gem || '—').padEnd(14)} ${r.name.padEnd(34)} ${(r.hero || '').padEnd(18)} ${c}`);
  }
}

function loadSnap(label) {
  const p = snapPath(label);
  if (!fs.existsSync(p)) throw new Error(`нет среза «${label}» — сначала snap`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function cmdDiff(a, b) {
  const A = loadSnap(a), B = loadSnap(b);
  const mapA = new Map(A.rows.map(r => [r.assetid, r]));
  const mins = (new Date(B.ts) - new Date(A.ts)) / 60000;
  console.log(`${a} → ${b}   прошло ${mins.toFixed(0)} мин`);

  let moved = 0;
  for (const rb of B.rows) {
    const ra = mapA.get(rb.assetid);
    if (!ra) { console.log(`  + новый  ${rb.gem} ${rb.name}`); continue; }
    for (const key of new Set([...Object.keys(ra.counters), ...Object.keys(rb.counters)])) {
      const was = ra.counters[key] ?? 0, now = rb.counters[key] ?? 0;
      if (now === was) continue;
      moved++;
      const rate = mins > 0 ? `  ${((now - was) / mins * 60).toFixed(1)}/час` : '';
      console.log(`  ▲ ${(rb.gem || '—').padEnd(14)} ${rb.name.padEnd(34)} ${key}: ${was} → ${now}  ${now - was > 0 ? '+' : ''}${now - was}${rate}`);
    }
  }
  for (const r of A.rows) if (!B.rows.some(x => x.assetid === r.assetid)) console.log(`  − пропал  ${r.gem} ${r.name}`);
  if (!moved) console.log('  счётчики не сдвинулись');
}

// watch — опрашивает инвентарь, пока счётчик не сдвинется. Выходит на первом движении.
async function cmdWatch(steamid, base, intervalSec, maxMin) {
  const iv = Number(intervalSec || 300), limit = Number(maxMin || 180);
  const A = loadSnap(base);
  const mapA = new Map(A.rows.map(r => [r.assetid, r]));
  const started = Date.now();
  console.log(`слежу за ${steamid}, база «${base}», опрос раз в ${iv} с, предел ${limit} мин`);

  for (let n = 1; ; n++) {
    await new Promise(r => setTimeout(r, iv * 1000));
    const mins = (Date.now() - started) / 60000;
    let body;
    try { body = await fetchInventory(steamid); }
    catch (e) { console.log(`  [${mins.toFixed(0)} мин] опрос ${n}: ${e.message}`); continue; }

    const rows = collect(body);
    const moved = [];
    for (const rb of rows) {
      const ra = mapA.get(rb.assetid);
      if (!ra) continue;
      for (const key of Object.keys(rb.counters)) {
        const was = ra.counters[key] ?? 0, now = rb.counters[key] ?? 0;
        if (now !== was) moved.push({ r: rb, key, was, now });
      }
    }

    if (moved.length) {
      const label = 'T1-auto';
      fs.writeFileSync(snapPath(label), JSON.stringify({ label, steamid, ts: new Date().toISOString(), total: body.total_inventory_count, rows }, null, 2));
      console.log(`
ДВИЖЕНИЕ через ${mins.toFixed(0)} мин, срез сохранён как ${label}:`);
      for (const m of moved)
        console.log(`  ▲ ${(m.r.gem || '—').padEnd(14)} ${m.r.name.padEnd(34)} ${m.key}: ${m.was} → ${m.now}  ${((m.now - m.was) / mins * 60).toFixed(1)}/час`);
      const gems = [...new Set(moved.map(m => m.r.gem))];
      console.log(`  двинулись гемы: ${gems.join(', ')}   предметов: ${moved.length} из ${A.rows.length}`);
      return;
    }
    console.log(`  [${mins.toFixed(0)} мин] опрос ${n}: без движения`);
    if (mins >= limit) { console.log(`
предел ${limit} мин, движения нет`); return; }
  }
}

function cmdList() {
  if (!fs.existsSync(DATA)) return console.log('срезов нет');
  const files = fs.readdirSync(DATA).filter(f => f.endsWith('.json')).sort();
  if (!files.length) return console.log('срезов нет');
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
    console.log(`${s.label.padEnd(16)} ${s.ts}  строк: ${s.rows.length}`);
  }
}

function cmdCsv() {
  const files = fs.readdirSync(DATA).filter(f => f.endsWith('.json')).sort();
  console.log('label,ts,assetid,gem,item,hero,counter,value');
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
    for (const r of s.rows)
      for (const [k, v] of Object.entries(r.counters))
        console.log([s.label, s.ts, r.assetid, `"${r.gem}"`, `"${r.name}"`, `"${r.hero}"`, k, v].join(','));
  }
}

const [cmd, ...args] = process.argv.slice(2);
const run = { snap: () => cmdSnap(args[0], args[1]), diff: () => cmdDiff(args[0], args[1]), watch: () => cmdWatch(args[0], args[1], args[2], args[3]), list: cmdList, csv: cmdCsv }[cmd];
if (!run) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 11).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(1);
}
Promise.resolve().then(run).catch(e => { console.error('ошибка:', e.message); process.exit(1); });
