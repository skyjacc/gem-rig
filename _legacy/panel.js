// panel — живой пульт прожига гемов Dota 2. Бэкенд и фронт в одном файле, без зависимостей.
//
//   node tools/panel.js                  http://localhost:4322
//   node tools/panel.js --port 5000 --steamid 765611...
//
// Обновление идёт через SSE: сервер сам толкает состояние, когда меняется
// status.json, delay.txt или инвентарь. Опроса со стороны браузера нет.
//
// Источники:
//   tools/gems.json            каталог Spectator Gem с рынка Steam
//   tools/gem-map.json         привязка гема к сущности OpenDota
//   tools/gem-supply.json      измеренный запас матчей по каждому гему
//   tools/gem-bundles.json     наборы из магазина Dota, которые идут уже с гемом
//   tools/gemtrack-data/*.json срезы инвентаря -> графики
//   tools/gcwatch/status.json  живое состояние отправщика
//   tools/gcwatch/sent-*.json  журналы сожжённых матчей
//   tools/gcwatch/delay.txt    темп, панель им управляет
//   tools/opendota.key         ключ OpenDota (в .gitignore) либо OPENDOTA_KEY
//   tools/steam.key            ключ Steam Web API — отдаёт, какие предметы надеты

const http = require('http');
const fs = require('fs');
const path = require('path');

const GC = path.join(__dirname, 'gcwatch');
const SNAPS = path.join(__dirname, 'gemtrack-data');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(opt('--port', 4322));
const STEAMID = opt('--steamid', '76561198362481819');

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return f; } };
const readKey = (file, env) => (process.env[env] || (() => { try { return fs.readFileSync(path.join(__dirname, file), 'utf8'); } catch (e) { return ''; } })()).trim() || null;
const odKey = () => readKey('opendota.key', 'OPENDOTA_KEY');
const steamKey = () => readKey('steam.key', 'STEAM_KEY');
const od = p => 'https://api.opendota.com/api' + p + (odKey() ? (p.includes('?') ? '&' : '?') + 'api_key=' + odKey() : '');

// ─────────────── очередь к Steam: не чаще одного запроса в 2.5 с ───────────────
const STEAM_GAP = 2500;
let steamQueue = Promise.resolve(), lastSteamAt = 0;
function steamFetch(url, init) {
  const run = async () => {
    const wait = Math.max(0, lastSteamAt + STEAM_GAP - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastSteamAt = Date.now();
    return fetch(url, init);
  };
  steamQueue = steamQueue.then(run, run);
  return steamQueue;
}

// ─────────────────────────────── инвентарь ───────────────────────────────
let invCache = { ts: 0, rows: [] }, invBackoff = 0, invError = null;
const INV_TTL = 60000, INV_BACKOFF = 300000;

function parseItem(desc) {
  const out = { counters: {}, gem: '', hero: '', icon: desc.icon_url || '' };
  for (const d of desc.descriptions || []) {
    const raw = d.value || '';
    const text = raw.replace(/<[^>]+>/g, '|').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\|+/g, '|');
    const used = raw.match(/^Used By:\s*(.+)$/);
    if (used) out.hero = used[1].trim();
    const g = text.match(/Games\s*Watched:\s*([\d,\s]+)/i);
    if (g) {
      out.counters.games_watched = Number(g[1].replace(/[\s,]/g, ''));
      const parts = text.split('|').map(s => s.trim()).filter(Boolean);
      const idx = parts.findIndex(p => /Games\s*Watched/i.test(p));
      if (idx > 0) out.gem = parts[idx - 1];
    }
    const k = text.match(/Kills:\s*([\d,\s]+)/i);
    if (k) out.counters.kills = Number(k[1].replace(/[\s,]/g, ''));
  }
  return out;
}

async function refreshInventory(force) {
  const now = Date.now();
  if (!force && now - invCache.ts < INV_TTL) return false;
  if (now < invBackoff) return false;
  try {
    const res = await steamFetch(`https://steamcommunity.com/inventory/${STEAMID}/570/2?l=english&count=2000`,
      { headers: { 'User-Agent': 'panel', Accept: 'application/json' } });
    if (res.status === 429) { invBackoff = now + INV_BACKOFF; throw new Error('Steam 429 — пауза 5 минут'); }
    if (!res.ok) throw new Error('Steam ' + res.status);
    const body = await res.json();
    const by = new Map();
    for (const d of body.descriptions) by.set(d.classid + '_' + d.instanceid, d);
    const rows = [];
    for (const a of body.assets) {
      const d = by.get(a.classid + '_' + a.instanceid);
      if (!d) continue;
      const p = parseItem(d);
      if (!Object.keys(p.counters).length) continue;
      rows.push({ assetid: a.assetid, name: d.market_hash_name || d.name, gem: p.gem, hero: p.hero, icon: p.icon, counters: p.counters });
    }
    invCache = { ts: now, rows };
    invError = null;
    return true;
  } catch (e) { invError = e.message; return false; }
}

// ─────── Steam Web API: какие предметы надеты (счётчика там нет) ───────
let webCache = { ts: 0, map: new Map() };
async function refreshWeb() {
  const key = steamKey();
  if (!key || Date.now() - webCache.ts < 120000) return;
  try {
    const r = await steamFetch(`https://api.steampowered.com/IEconItems_570/GetPlayerItems/v1/?key=${key}&steamid=${STEAMID}`,
      { headers: { 'User-Agent': 'panel' } });
    if (!r.ok) return;
    const j = await r.json();
    const map = new Map();
    for (const it of (j.result && j.result.items) || []) {
      map.set(String(it.id), { equipped: Array.isArray(it.equipped) && it.equipped.length > 0 });
    }
    webCache = { ts: Date.now(), map };
  } catch (e) { /* необязательный источник */ }
}

// ─────────────────────────── журналы и снимки ────────────────────────────
function burnedSet() {
  const set = new Set();
  if (!fs.existsSync(GC)) return set;
  for (const f of fs.readdirSync(GC)) {
    if (!/^sent-.+\.json$/.test(f)) continue;
    for (const m of readJson(path.join(GC, f), [])) set.add(String(m));
  }
  return set;
}

function history() {
  if (!fs.existsSync(SNAPS)) return [];
  const points = [];
  for (const f of fs.readdirSync(SNAPS).filter(x => x.endsWith('.json'))) {
    const s = readJson(path.join(SNAPS, f), null);
    if (!s || !s.rows) continue;
    const byGem = {};
    for (const r of s.rows) {
      const v = r.counters.games_watched;
      if (v === undefined) continue;
      byGem[r.gem || '—'] = Math.max(byGem[r.gem || '—'] || 0, v);
    }
    points.push({ label: s.label, ts: Date.parse(s.ts), gems: byGem });
  }
  return points.sort((a, b) => a.ts - b.ts);
}

// ─────────── матчи сущности: нужны и для остатка, и для сборки списка ───────────
const matchCache = new Map();
async function entityMatches(kind, id) {
  const key = kind + ':' + id;
  if (matchCache.has(key)) return matchCache.get(key);
  let url = null;
  if (kind === 'team') url = od('/teams/' + id + '/matches');
  else if (kind === 'league') url = od('/leagues/' + id + '/matches');
  else if (kind === 'player') url = od('/players/' + id + '/matches?significant=1');
  if (!url) return [];
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'panel' } });
    let rows = await r.json();
    if (!Array.isArray(rows)) return [];
    if (kind === 'player') rows = rows.filter(m => m.lobby_type === 1);
    const out = rows.filter(m => m.match_id).map(m => ({ id: String(m.match_id), league: m.leagueid || m.league_id || '' }));
    matchCache.set(key, out);
    return out;
  } catch (e) { return []; }
}

async function buildList(kind, id, count, name) {
  const rows = await entityMatches(kind, id);
  if (!rows.length) throw new Error('OpenDota не отдал матчи');
  const burned = burnedSet();
  const lines = [];
  for (const m of rows) {
    if (burned.has(m.id)) continue;
    lines.push(m.id + ',' + m.league);
    if (count && lines.length >= count) break;
  }
  const safe = String(name || (kind + '-' + id)).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  const file = path.join(GC, 'build-' + safe + '.csv');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { file: path.basename(file), total: rows.length, fresh: lines.length, burned: rows.length - lines.length };
}

// ──────────────────────────────── состояние ──────────────────────────────
async function state() {
  const status = readJson(path.join(GC, 'status.json'), { current: null, recent: [] });
  let delay = null;
  try { delay = Number(fs.readFileSync(path.join(GC, 'delay.txt'), 'utf8').trim()); } catch (e) { }

  const rows = invCache.rows;
  const web = webCache.map;
  for (const r of rows) { const w = web.get(String(r.assetid)); if (w) r.equipped = w.equipped; }

  const catalog = readJson(path.join(__dirname, 'gems.json'), []);
  const map = readJson(path.join(__dirname, 'gem-map.json'), []);
  const supply = readJson(path.join(__dirname, 'gem-supply.json'), {});
  const bundles = readJson(path.join(__dirname, 'gem-bundles.json'), []);
  const short = s => String(s || '').replace(/^(Genuine\s+)?Spectator:\s*/, '').trim().toLowerCase();
  const mapBy = new Map(map.map(m => [short(m.name), m]));
  const supBy = new Map(Object.entries(supply).map(([k, v]) => [short(k), v]));

  const owned = new Map();
  for (const r of rows) {
    if (r.counters.games_watched === undefined) continue;
    const g = r.gem || '—';
    if (!owned.has(g)) owned.set(g, { gem: g, items: 0, equipped: 0, min: null, max: 0, icon: r.icon, heroes: new Set(), list: [] });
    const e = owned.get(g), v = r.counters.games_watched;
    e.items++; e.max = Math.max(e.max, v);
    e.min = e.min === null ? v : Math.min(e.min, v);
    if (r.equipped) e.equipped++;
    if (r.hero) e.heroes.add(r.hero);
    e.list.push({ name: r.name, hero: r.hero, value: v, equipped: !!r.equipped });
  }

  const mine = [...owned.values()].map(e => {
    const m = mapBy.get(short(e.gem)) || null;
    const sup = supBy.get(short(e.gem)) ?? (m && m.matches_estimate) ?? null;
    return {
      gem: e.gem, items: e.items, equipped: e.equipped, min: e.min, max: e.max, icon: e.icon,
      heroes: [...e.heroes].join(', '), list: e.list.sort((a, b) => b.value - a.value),
      kind: m && m.kind, entityId: m && m.entity_id, entityName: m && m.entity_name, supply: sup,
    };
  }).sort((a, b) => b.items - a.items || b.max - a.max);

  const cat = catalog.map(c => {
    const s = short(c.name);
    const m = mapBy.get(s) || null;
    const own = mine.find(x => short(x.gem) === s);
    const sup = supBy.get(s) ?? (m && m.matches_estimate) ?? null;
    return {
      name: c.name, short: c.name.replace(/^(Genuine\s+)?Spectator:\s*/, '').trim() || 'без имени',
      price: c.price, listings: c.listings, icon: c.icon,
      market: 'https://steamcommunity.com/market/listings/570/' + encodeURIComponent(c.name),
      kind: m && m.kind, entityId: m && m.entity_id, entityName: m && m.entity_name, supply: sup,
      per1000: sup ? (parseFloat(String(c.price).replace(/[^\d.]/g, '')) / sup * 1000) : null,
      ownedItems: own ? own.items : 0, ownedValue: own ? own.max : null,
    };
  }).sort((a, b) => (b.supply || 0) - (a.supply || 0));

  const burned = burnedSet();

  // Главная сущность: та, чьих предметов больше всего. По ней считаем остаток жилы.
  const primary = mine.find(m => m.entityId && m.supply) || null;
  let seam = null;
  if (primary) {
    const list = matchCache.get(primary.kind + ':' + primary.entityId) || [];
    const spent = list.length ? list.filter(m => burned.has(m.id)).length : burned.size;
    seam = { gem: primary.gem, entity: primary.entityName || primary.gem, total: primary.supply, spent, left: Math.max(0, primary.supply - spent), items: primary.items };
  }

  return {
    ts: Date.now(), steamid: STEAMID, delay, status, seam,
    mine, catalog: cat, bundles, history: history(),
    invError, invAge: invCache.ts ? Math.round((Date.now() - invCache.ts) / 1000) : null,
    burnedTotal: burned.size, totalItems: rows.length,
    totalWatched: mine.reduce((a, b) => a + b.max, 0),
    keys: { opendota: !!odKey(), steam: !!steamKey() },
  };
}

// ──────────────────────────────── страница ───────────────────────────────
const PAGE = String.raw`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Жила</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --ink:#0d1211; --seam:#131a18; --raise:#182220; --rule:#243230;
  --chalk:#e6ebe7; --dust:#7d8f89; 
  --malachite:#34d3a6; --oxide:#e2673a; --dry:#8a6bd1;
  --mono:"IBM Plex Mono",ui-monospace,Consolas,monospace;
  --disp:"Bricolage Grotesque","Segoe UI",system-ui,sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--ink);color:var(--chalk);font:13px/1.5 var(--mono)}
body{background-image:radial-gradient(1200px 500px at 12% -10%, #16211f 0%, transparent 60%)}
a{color:var(--malachite);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--malachite);outline-offset:2px}

/* ─── шапка ─── */
header{position:sticky;top:0;z-index:30;background:rgba(13,18,17,.94);backdrop-filter:blur(8px);
  border-bottom:1px solid var(--rule);display:flex;align-items:stretch;height:56px}
.mark{display:flex;align-items:center;gap:11px;padding:0 18px;border-right:1px solid var(--rule)}
.mark .dot{width:7px;height:7px;border-radius:50%;background:var(--dust)}
.mark .dot.live{background:var(--malachite);box-shadow:0 0 0 0 rgba(52,211,166,.6);animation:pulse 2.4s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,166,.5)}70%{box-shadow:0 0 0 9px rgba(52,211,166,0)}100%{box-shadow:0 0 0 0 rgba(52,211,166,0)}}
.mark .name{font:800 15px/1 var(--disp);letter-spacing:.03em}
.mark .sub{font-size:10px;color:var(--dust);letter-spacing:.22em;text-transform:uppercase}
.clock{padding:0 16px;display:flex;align-items:center;font-size:15px;color:var(--dust);border-right:1px solid var(--rule);font-variant-numeric:tabular-nums}
nav{display:flex;margin-left:auto}
nav button{background:none;border:0;border-left:1px solid var(--rule);color:var(--dust);
  padding:0 16px;cursor:pointer;font:500 11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase}
nav button:hover{color:var(--chalk);background:var(--raise)}
nav button.on{color:var(--ink);background:var(--malachite)}

/* ─── жила ─── */
.seam{padding:34px 26px 26px;border-bottom:1px solid var(--rule)}
.seam .eyebrow{font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:var(--dust)}
.seam .figure{display:flex;align-items:flex-end;gap:16px;margin:6px 0 4px}
.seam .num{font:800 clamp(48px,9vw,104px)/0.85 var(--disp);letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.seam .unit{font-size:12px;color:var(--dust);padding-bottom:10px;max-width:250px}
.gauge{height:14px;background:var(--seam);border:1px solid var(--rule);position:relative;overflow:hidden;margin-top:14px}
.gauge i{position:absolute;left:0;top:0;bottom:0;background:var(--oxide);transition:width .6s cubic-bezier(.2,.8,.2,1)}
.gauge b{position:absolute;top:0;bottom:0;width:1px;background:var(--rule)}
.gauge-legend{display:flex;justify-content:space-between;margin-top:7px;font-size:11px;color:var(--dust)}

/* ─── лента прожига ─── */
.tape{border-bottom:1px solid var(--rule);padding:16px 26px;display:flex;align-items:center;gap:18px}
.tape .strip{flex:1;height:52px;display:flex;align-items:flex-end;gap:2px;overflow:hidden;direction:rtl}
.tape .t{width:5px;flex:0 0 5px;background:var(--rule);animation:rise .5s cubic-bezier(.2,.9,.2,1)}
.tape .t.up{background:var(--malachite)} .tape .t.dup{background:var(--oxide);opacity:.75}
.tape .t.sil{background:#7a2b2b}
@keyframes rise{from{transform:scaleY(.05);opacity:0}to{transform:scaleY(1);opacity:1}}
@media (prefers-reduced-motion:reduce){.tape .t{animation:none}.mark .dot.live{animation:none}}

main{padding:0 26px 60px}
.tab{display:none} .tab.on{display:block}
.cols{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));padding:22px 0}
.card{border:1px solid var(--rule);background:var(--seam)}
.card h3{margin:0;padding:11px 14px;font:500 10px/1 var(--mono);letter-spacing:.22em;text-transform:uppercase;
  color:var(--dust);border-bottom:1px solid var(--rule)}
.card .in{padding:14px}
.kv{display:flex;justify-content:space-between;gap:14px;padding:6px 0;border-bottom:1px solid rgba(36,50,48,.6)}
.kv:last-child{border:0}
.kv span:first-child{color:var(--dust)}
.stat{font:800 30px/1 var(--disp);font-variant-numeric:tabular-nums}
.mal{color:var(--malachite)} .ox{color:var(--oxide)} .dm{color:var(--dust)}

.blk{border:1px solid var(--rule);background:var(--seam);margin:22px 0}
.blk>header{position:static;height:auto;background:none;border:0;border-bottom:1px solid var(--rule);
  padding:11px 14px;display:flex;align-items:center;gap:14px;backdrop-filter:none}
.blk>header h3{margin:0;font:500 10px/1 var(--mono);letter-spacing:.22em;text-transform:uppercase;color:var(--dust)}
.blk .note{margin-left:auto;font-size:11px;color:var(--dust)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font:500 10px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dust);
  padding:9px 12px;border-bottom:1px solid var(--rule)}
td{padding:7px 12px;border-bottom:1px solid rgba(36,50,48,.55)}
tbody tr:hover td{background:var(--raise)}
.n{text-align:right}
.ico{width:30px;height:30px;object-fit:contain;background:var(--ink);border:1px solid var(--rule);vertical-align:middle}
.ico.sm{width:20px;height:20px}
.pill{display:inline-block;padding:1px 7px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;
  border:1px solid var(--rule);color:var(--dust)}
.pill.team{color:var(--malachite);border-color:#1e5a49}
.pill.player{color:#7fb7ff;border-color:#25405e}
.pill.league{color:var(--oxide);border-color:#5c3220}
.pill.studio{color:var(--dry);border-color:#3f3363}
.btn{background:var(--raise);border:1px solid var(--rule);color:var(--chalk);padding:5px 10px;
  cursor:pointer;font:500 11px/1.3 var(--mono)}
.btn:hover{border-color:var(--malachite);color:var(--malachite)}
.btn.on{background:var(--malachite);color:var(--ink);border-color:var(--malachite)}
.pace{display:flex;gap:5px;flex-wrap:wrap;margin-top:11px}
.buy{border:1px solid var(--rule);padding:4px 9px;font-size:11px;color:var(--malachite);display:inline-block}
.buy:hover{background:var(--raise);text-decoration:none}
input[type=search]{background:var(--ink);border:1px solid var(--rule);color:var(--chalk);
  padding:8px 12px;font:400 13px var(--mono);width:100%;max-width:330px}
input[type=search]::placeholder{color:var(--dust)}
.log{max-height:290px;overflow:auto;font-size:11.5px}
.log div{padding:4px 14px;border-bottom:1px solid rgba(36,50,48,.5);white-space:nowrap}
.chart{width:100%;height:190px;display:block}
.empty{padding:18px 14px;color:var(--dust)}
@media(max-width:700px){
  header{height:auto;flex-wrap:wrap} nav{width:100%;margin:0;overflow-x:auto}
  nav button{padding:12px 13px;border-top:1px solid var(--rule)}
  .seam,.tape,main{padding-left:14px;padding-right:14px}
}
</style></head><body>

<header>
  <div class="mark"><span class="dot" id="dot"></span>
    <span><span class="name">Жила</span> <span class="sub" id="conn">нет связи</span></span></div>
  <div class="clock" id="clock">--:--:--</div>
  <nav>
    <button class="on" data-tab="rig">Пульт</button>
    <button data-tab="mine">Мои гемы</button>
    <button data-tab="cat">Каталог</button>
    <button data-tab="bund">Наборы</button>
  </nav>
</header>

<section class="seam">
  <div class="eyebrow" id="seam-eyebrow">запас не определён</div>
  <div class="figure"><div class="num" id="seam-num">—</div><div class="unit" id="seam-unit"></div></div>
  <div class="gauge"><i id="seam-fill" style="width:0"></i></div>
  <div class="gauge-legend"><span id="seam-spent">—</span><span id="seam-total">—</span></div>
</section>

<div class="tape">
  <div style="min-width:96px"><div class="eyebrow" style="font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:var(--dust)">лента</div>
    <div id="tape-rate" class="dm" style="font-size:11px">ожидание</div></div>
  <div class="strip" id="strip"></div>
</div>

<main>
  <div class="tab on" id="tab-rig"></div>
  <div class="tab" id="tab-mine"></div>
  <div class="tab" id="tab-cat"></div>
  <div class="tab" id="tab-bund"></div>
</main>

<script>
const esc = s => String(s==null?'':s).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const nf = n => (n==null?'—':String(n).replace(/\B(?=(\d{3})+(?!\d))/g,' '));
const dur = ms => { if(!ms||ms<0) return '—'; const m=Math.round(ms/60000); return m<60? m+' мин' : Math.floor(m/60)+' ч '+(m%60)+' мин'; };
const icon = (ic,cls) => ic ? '<img class="ico '+(cls||'')+'" loading="lazy" alt="" src="https://community.cloudflare.steamstatic.com/economy/image/'+ic+'/62fx62f">' : '';
const pill = k => k ? '<span class="pill '+k+'">'+({team:'команда',player:'игрок',league:'лига',studio:'студия',unknown:'?'}[k]||k)+'</span>' : '<span class="pill">—</span>';
const PACE = [[2000,'2 с'],[3000,'3 с'],[10000,'10 с'],[30000,'30 с'],[60000,'1 мин'],[120000,'2 мин'],[300000,'5 мин']];

let S=null, tab='rig', q='', seen=new Set();

setInterval(()=>{document.getElementById('clock').textContent=new Date().toLocaleTimeString('ru-RU')},500);

document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{
  tab=b.dataset.tab;
  document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('on',x===b));
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.id==='tab-'+tab));
  if(S) paint();
});

window.setPace = async v => { await fetch('/api/delay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delay:v})}); };
window.build = async (kind,id,name,btn) => {
  const old=btn.textContent; btn.disabled=true; btn.textContent='собираю';
  try{ const j=await (await fetch('/api/build',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({kind,id,name,count:0})})).json();
    btn.textContent = j.error ? 'ошибка' : j.fresh+' → '+j.file;
  }catch(e){ btn.textContent='ошибка'; }
  setTimeout(()=>{btn.disabled=false;btn.textContent=old},8000);
};

// ── лента: добавляем только новые события, старые не перерисовываем ──
function tape(){
  const strip=document.getElementById('strip');
  const rec=(S.status.recent||[]);
  const fresh=rec.filter(e=>!seen.has(e.ts+'_'+e.match)).reverse();
  for(const e of fresh){
    seen.add(e.ts+'_'+e.match);
    const d=document.createElement('div');
    const h = e.result==='update' ? Math.min(52, 14+(e.bytes||0)/22) : e.result==='dup' ? 16 : 9;
    d.className='t '+(e.result==='update'?'up':e.result==='dup'?'dup':'sil');
    d.style.height=h+'px';
    d.title=e.match+' · лига '+(e.league||'—')+' · '+(e.result==='update'?e.bytes+' байт':e.result);
    strip.prepend(d);
  }
  while(strip.children.length>220) strip.lastChild.remove();
  const ups=rec.filter(e=>e.result==='update').length;
  document.getElementById('tape-rate').textContent = rec.length ? ups+' из '+rec.length+' засчитано' : 'ожидание';
}

function seam(){
  const s=S.seam;
  if(!s){ document.getElementById('seam-eyebrow').textContent='запас не определён — инвентарь ещё не прочитан'; return; }
  document.getElementById('seam-eyebrow').textContent='осталось матчей · '+s.gem;
  document.getElementById('seam-num').textContent=nf(s.left);
  document.getElementById('seam-unit').innerHTML='матчей, которые ещё можно засчитать. Поднимают '+s.items+' предмет'+(s.items%10===1&&s.items!==11?'':'ов')+' разом.';
  document.getElementById('seam-fill').style.width=(100*s.spent/Math.max(1,s.total))+'%';
  document.getElementById('seam-spent').textContent='сожжено '+nf(s.spent);
  document.getElementById('seam-total').textContent='всего в жиле '+nf(s.total);
}

function cardPace(){
  const c=S.status.current;
  return '<div class="card"><h3>Отправка</h3><div class="in">'+
    '<div class="stat">'+(c? c.n+' <span class="dm" style="font-size:15px">/ '+c.total+'</span>':'—')+'</div>'+
    '<div class="kv"><span>осталось</span><span>'+(c?dur((c.total-c.n)*(S.delay||c.delay||0)):'—')+'</span></div>'+
    '<div class="kv"><span>засчитано / ответов</span><span><span class="mal">'+(c?c.updates:'—')+'</span> / '+(c?c.responses:'—')+'</span></div>'+
    '<div class="kv"><span>последний</span><span>'+(c?esc(c.match):'—')+'</span></div>'+
    '<div class="pace">'+PACE.map(p=>'<button class="btn'+(S.delay===p[0]?' on':'')+'" onclick="setPace('+p[0]+')">'+p[1]+'</button>').join('')+'</div>'+
    '</div></div>';
}

function cardStock(){
  return '<div class="card"><h3>Инвентарь</h3><div class="in">'+
    '<div class="stat mal">'+nf(S.totalWatched)+'</div>'+
    '<div class="kv"><span>сумма счётчиков</span><span></span></div>'+
    '<div class="kv"><span>предметов со счётчиком</span><span>'+S.totalItems+'</span></div>'+
    '<div class="kv"><span>групп гемов</span><span>'+S.mine.length+'</span></div>'+
    '<div class="kv"><span>прочитан</span><span>'+(S.invAge!=null?S.invAge+' с назад':'—')+'</span></div>'+
    (S.invError?'<div class="kv"><span>Steam</span><span class="ox">'+esc(S.invError)+'</span></div>':'')+
    '</div></div>';
}

function cardBurn(){
  return '<div class="card"><h3>Сожжено</h3><div class="in">'+
    '<div class="stat ox">'+nf(S.burnedTotal)+'</div>'+
    '<div class="kv"><span>матчей израсходовано</span><span></span></div>'+
    '<div class="kv"><span>ключ OpenDota</span><span>'+(S.keys.opendota?'<span class="mal">есть</span>':'нет')+'</span></div>'+
    '<div class="kv"><span>ключ Steam Web API</span><span>'+(S.keys.steam?'<span class="mal">есть</span>':'нет')+'</span></div>'+
    '<div class="kv"><span>наборов с гемом</span><span>'+S.bundles.length+'</span></div>'+
    '</div></div>';
}

function blockLog(){
  const rec=S.status.recent||[];
  return '<div class="blk"><header><h3>События</h3><span class="note">последние '+rec.length+'</span></header>'+
    '<div class="log">'+(rec.map(e=>{
      const cls=e.result==='update'?'mal':e.result==='dup'?'ox':'dm';
      const txt=e.result==='update'?'засчитан · '+e.bytes+' байт':e.result==='dup'?'уже сожжён':'нет ответа';
      return '<div><span class="dm">'+new Date(e.ts).toLocaleTimeString('ru-RU')+'</span>  '+
        e.n+'/'+e.total+'  '+esc(e.match)+'  <span class="dm">лига '+(e.league||'—')+'</span>  <span class="'+cls+'">'+txt+'</span></div>';
    }).join('')||'<div class="empty">событий пока нет</div>')+'</div></div>';
}

function blockChart(){
  return '<div class="blk"><header><h3>Рост счётчиков</h3><span class="note">по срезам инвентаря</span></header>'+
    '<div style="padding:14px"><svg class="chart" id="chart"></svg><div class="note" id="legend" style="margin-top:8px"></div></div></div>';
}

function drawChart(){
  const el=document.getElementById('chart'); if(!el) return;
  const h=S.history||[];
  if(h.length<2){ el.innerHTML='<text x="4" y="20" fill="#7d8f89" font-size="12" font-family="IBM Plex Mono">нужно минимум два среза</text>'; return; }
  const names=[...new Set(h.flatMap(p=>Object.keys(p.gems)))].filter(n=>h.some(p=>(p.gems[n]||0)>0));
  const cols=['#34d3a6','#e2673a','#7fb7ff','#8a6bd1','#d8c15a','#5fd0d0'];
  const ser=names.map((n,i)=>({n,c:cols[i%cols.length],p:h.map(x=>x.gems[n]||0)}));
  const W=el.clientWidth||900,H=190,P={l:46,r:10,t:10,b:16};
  const max=Math.max(1,...ser.flatMap(s=>s.p));
  const X=i=>P.l+(W-P.l-P.r)*(i/Math.max(1,h.length-1)), Y=v=>H-P.b-(H-P.t-P.b)*(v/max);
  el.setAttribute('viewBox','0 0 '+W+' '+H);
  el.innerHTML=[0,.5,1].map(f=>{const y=Y(max*f);
    return '<line x1="'+P.l+'" y1="'+y+'" x2="'+(W-P.r)+'" y2="'+y+'" stroke="#243230"/>'+
      '<text x="'+(P.l-6)+'" y="'+(y+4)+'" fill="#7d8f89" font-size="10" font-family="IBM Plex Mono" text-anchor="end">'+Math.round(max*f)+'</text>';}).join('')
    + ser.map(s=>'<path d="'+s.p.map((v,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)).join(' ')+'" fill="none" stroke="'+s.c+'" stroke-width="1.75"/>').join('');
  document.getElementById('legend').innerHTML=ser.map(s=>'<span style="margin-right:14px"><span style="display:inline-block;width:8px;height:8px;background:'+s.c+'"></span> '+esc(s.n)+'</span>').join('');
}

function blockMine(){
  return '<div class="blk"><header><h3>Гемы в инвентаре</h3><span class="note">'+S.mine.length+' групп</span></header>'+
    '<table><thead><tr><th></th><th>Гем</th><th>Тип</th><th class="n">Предметов</th><th class="n">Надето</th>'+
    '<th class="n">Счётчик</th><th class="n">Запас</th><th>Герои</th><th></th></tr></thead><tbody>'+
    (S.mine.map(m=>'<tr><td>'+icon(m.icon)+'</td><td>'+esc(m.gem)+'</td><td>'+pill(m.kind)+'</td>'+
      '<td class="n">'+m.items+'</td><td class="n '+(m.equipped?'mal':'dm')+'">'+m.equipped+'</td>'+
      '<td class="n '+(m.max?'mal':'dm')+'">'+(m.min===m.max?m.max:m.min+'–'+m.max)+'</td>'+
      '<td class="n dm">'+nf(m.supply)+'</td><td class="dm">'+esc(m.heroes)+'</td>'+
      '<td class="n">'+(m.entityId&&m.kind&&m.kind!=='unknown'
        ?'<button class="btn" onclick="build(\''+m.kind+'\','+m.entityId+',\''+esc(m.gem).replace(/\x27/g,'')+'\',this)">Список</button>':'')+
      '</td></tr>').join('')||'<tr><td colspan="9" class="empty">инвентарь ещё не прочитан</td></tr>')+'</tbody></table></div>';
}

function blockCat(){
  const rows=S.catalog.filter(c=>!q||(c.name+' '+(c.entityName||'')+' '+(c.kind||'')).toLowerCase().includes(q));
  return '<div class="blk"><header><h3>Все гемы на рынке</h3>'+
    '<span class="note">'+rows.length+' из '+S.catalog.length+'</span></header>'+
    '<div style="padding:14px"><input type="search" id="q" placeholder="имя, команда, тип" value="'+esc(q)+'"></div>'+
    '<table><thead><tr><th></th><th>Гем</th><th>Тип</th><th>Сущность</th><th class="n">Матчей</th>'+
    '<th class="n">Цена</th><th class="n">$/1000</th><th class="n">Лотов</th><th class="n">У меня</th><th></th><th></th></tr></thead><tbody>'+
    (rows.map(c=>'<tr><td>'+icon(c.icon)+'</td><td>'+esc(c.short)+'</td><td>'+pill(c.kind)+'</td>'+
      '<td class="dm">'+esc((c.entityName||'').slice(0,34))+'</td>'+
      '<td class="n">'+nf(c.supply)+'</td><td class="n">'+esc(c.price)+'</td>'+
      '<td class="n '+(c.per1000!=null&&c.per1000<0.02?'mal':'dm')+'">'+(c.per1000!=null?'$'+c.per1000.toFixed(3):'—')+'</td>'+
      '<td class="n dm">'+c.listings+'</td>'+
      '<td class="n '+(c.ownedItems?'mal':'dm')+'">'+(c.ownedItems||'—')+'</td>'+
      '<td class="n"><a class="buy" href="'+c.market+'" target="_blank" rel="noopener">Купить</a></td>'+
      '<td class="n">'+(c.entityId&&c.kind&&c.kind!=='unknown'
        ?'<button class="btn" onclick="build(\''+c.kind+'\','+c.entityId+',\''+esc(c.short).replace(/\x27/g,'')+'\',this)">Список</button>':'')+
      '</td></tr>').join('')||'<tr><td colspan="11" class="empty">ничего не найдено</td></tr>')+'</tbody></table></div>';
}

function blockBund(){
  return '<div class="blk"><header><h3>Наборы, которые продаются уже с гемом</h3>'+
    '<span class="note">сокет занят, чисел не нужен</span></header>'+
    '<table><thead><tr><th></th><th>Набор</th><th>Гем</th><th>Герой</th><th class="n">Частей</th>'+
    '<th class="n">Цена</th><th>Создан</th><th></th><th></th></tr></thead><tbody>'+
    S.bundles.map(b=>'<tr><td>'+(b.hero?'<img class="ico sm" loading="lazy" alt="" src="https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/icons/'+b.hero+'.png">':'')+'</td>'+
      '<td>'+esc(b.name)+'</td><td class="dm">'+esc(b.partner)+'</td>'+
      '<td class="dm">'+esc((b.hero||'').replace(/_/g,' '))+'</td><td class="n">'+(b.pieces||'—')+'</td>'+
      '<td class="n">'+(b.price_cents!=null?'$'+(b.price_cents/100).toFixed(2):'—')+'</td>'+
      '<td class="dm">'+esc(b.created)+'</td>'+
      '<td class="n"><a class="buy" href="https://www.dota2.com/store/itemdetails/'+b.def+'" target="_blank" rel="noopener">Магазин</a></td>'+
      '<td class="n"><a class="buy" href="https://steamcommunity.com/market/listings/570/'+encodeURIComponent(b.name)+'" target="_blank" rel="noopener">Рынок</a></td></tr>').join('')+
    '</tbody></table></div>';
}

function paint(){
  seam(); tape();
  if(tab==='rig')  document.getElementById('tab-rig').innerHTML='<div class="cols">'+cardPace()+cardStock()+cardBurn()+'</div>'+blockLog()+blockChart();
  if(tab==='mine') document.getElementById('tab-mine').innerHTML=blockMine();
  if(tab==='cat')  document.getElementById('tab-cat').innerHTML=blockCat();
  if(tab==='bund') document.getElementById('tab-bund').innerHTML=blockBund();
  const s=document.getElementById('q');
  if(s){ s.oninput=e=>{ q=e.target.value.toLowerCase(); paint();
    const n=document.getElementById('q'); if(n){n.focus();n.setSelectionRange(q.length,q.length);} }; }
  if(tab==='rig') drawChart();
}

// ── SSE ──
let es;
function connect(){
  es=new EventSource('/api/stream');
  es.onopen=()=>{document.getElementById('dot').classList.add('live');document.getElementById('conn').textContent='в эфире';};
  es.onerror=()=>{document.getElementById('dot').classList.remove('live');document.getElementById('conn').textContent='переподключение';};
  es.onmessage=ev=>{ S=JSON.parse(ev.data); paint(); };
}
connect();
</script></body></html>`;

// ──────────────────────────────── сервер ─────────────────────────────────
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b)); } catch (e) { r({}); } }); });

const clients = new Set();
let pushing = false;

async function push() {
  if (pushing || !clients.size) return;
  pushing = true;
  try {
    const s = await state();
    const line = 'data: ' + JSON.stringify(s) + '\n\n';
    for (const res of clients) { try { res.write(line); } catch (e) { clients.delete(res); } }
  } catch (e) { /* следующий тик */ }
  pushing = false;
}

// Толкаем при изменении файлов отправщика и по таймеру для инвентаря.
function watchFiles() {
  if (!fs.existsSync(GC)) return;
  let t = null;
  fs.watch(GC, (ev, name) => {
    if (!name || !/^(status\.json|delay\.txt|sent-.*\.json)$/.test(name)) return;
    clearTimeout(t);
    t = setTimeout(push, 120);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    try { res.write('data: ' + JSON.stringify(await state()) + '\n\n'); } catch (e) { }
    return;
  }

  if (url === '/api/delay' && req.method === 'POST') {
    const { delay } = await readBody(req);
    if (Number.isFinite(delay) && delay >= 500) fs.writeFileSync(path.join(GC, 'delay.txt'), String(delay));
    push();
    return json(res, 200, { ok: true });
  }

  if (url === '/api/build' && req.method === 'POST') {
    const { kind, id, count, name } = await readBody(req);
    try { json(res, 200, await buildList(kind, id, Number(count) || 0, name)); }
    catch (e) { json(res, 200, { error: e.message }); }
    return;
  }

  if (url === '/api/state') { try { json(res, 200, await state()); } catch (e) { json(res, 500, { error: e.message }); } return; }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

server.listen(PORT, async () => {
  console.log('Жила: http://localhost:' + PORT);
  console.log('OpenDota: ' + (odKey() ? 'ключ' : 'без ключа') + ' | Steam Web API: ' + (steamKey() ? 'ключ' : 'без ключа'));
  watchFiles();

  // Прогреваем матчи главной сущности, чтобы остаток жилы считался точно.
  const map = readJson(path.join(__dirname, 'gem-map.json'), []);
  const empire = map.find(m => m.name === 'Spectator: Team Empire');
  if (empire && empire.entity_id) entityMatches(empire.kind, empire.entity_id).then(() => push());

  const cycle = async () => {
    const changed = await refreshInventory(false);
    await refreshWeb();
    if (changed || clients.size) push();
  };
  cycle();
  setInterval(cycle, 20000);
});
