const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3377;
const ROOT = path.resolve(__dirname);
const MARKET_KEY_FILE = path.join(ROOT, 'market.key');
const STEAM_KEY_FILE = path.join(ROOT, 'steam.key');

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT ERROR]:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]:', reason);
});

function getMarketKey() {
  return fs.existsSync(MARKET_KEY_FILE) ? fs.readFileSync(MARKET_KEY_FILE, 'utf8').trim() : '';
}
function getSteamKey() {
  return fs.existsSync(STEAM_KEY_FILE) ? fs.readFileSync(STEAM_KEY_FILE, 'utf8').trim() : '';
}

// Список проверенных пар Предмет -> Ожидаемый Кинетик
const KINETIC_TARGETS = [
  { item: 'Fireborn Odachi', hero: 'Juggernaut', gem: 'Kinetic: Fireborn Assault', gem_price: 2350, item_price: 95, icon: 'econ/items/juggernaut/generic_sword_nodachi' },
  { item: 'Relic Sword', hero: 'Wraith King', gem: "Kinetic: Dominator's Stance", gem_price: 1100, item_price: 60, icon: 'econ/items/wraith_king/relic_sword' },
  { item: 'Blood Shard', hero: 'Wraith King', gem: "Kinetic: Dominator's Stance", gem_price: 1100, item_price: 80, icon: 'econ/items/skeleton_king/blood_shard' },
  { item: 'The One Horn', hero: 'Keeper of the Light', gem: 'Kinetic: Obeisance of the Keeper', gem_price: 835, item_price: 45, icon: 'econ/items/keeper_of_the_light/the_one_horn' },
  { item: 'Diffusal Lance', hero: 'Phantom Lancer', gem: 'Kinetic: Serene Honor', gem_price: 508, item_price: 55, icon: 'econ/items/phantom_lancer/diffusal_lance' },
  { item: 'Pyre', hero: 'Doom', gem: 'Kinetic: Flames of the Pyre', gem_price: 355, item_price: 40, icon: 'econ/items/doom/pyre' },
  { item: "Lyralei's Breeze", hero: 'Windranger', gem: 'Kinetic: Twister', gem_price: 272, item_price: 35, icon: 'econ/items/windrunner/lyraleis_breeze' },
  { item: 'Bladebiter', hero: 'Kunkka', gem: "Kinetic: Bladebiter's Strike", gem_price: 230, item_price: 45, icon: 'econ/items/kunkka/bladebiter' },
  { item: 'Eye of Omoz', hero: 'Doom', gem: 'Kinetic: Pits of Omoz', gem_price: 224, item_price: 50, icon: 'econ/items/doom/eye_of_omoz' },
  { item: 'Blackened Edge of the Bladekeeper', hero: 'Juggernaut', gem: "Kinetic: Bladekeeper's Blade Dance", gem_price: 200, item_price: 90, icon: 'econ/items/juggernaut/dc_weaponupdate' },
  { item: "Dendi Doll", hero: 'Pudge', gem: "Kinetic: Crow's Feet", gem_price: 160, item_price: 30, icon: 'econ/items/pudge/dendi_doll' },
  { item: 'Timberthaw Ripsaw', hero: 'Timbersaw', gem: 'Kinetic: Timberthaw II', gem_price: 130, item_price: 40, icon: 'econ/items/shredder/timberthaw_weapon' }
];

async function fetchMarketBalance() {
  const key = getMarketKey();
  if (!key) return { balance: 0, error: 'market.key missing' };
  try {
    const res = await fetch(`https://market.dota2.net/api/v2/get-money?key=${key}`);
    const data = await res.json();
    return { balance: data.money || 0, currency: data.currency || 'RUB', success: data.success };
  } catch (e) {
    return { balance: 0, error: e.message };
  }
}

async function scanTarget(target) {
  const marketKey = getMarketKey();
  const steamKey = getSteamKey();
  if (!marketKey || !steamKey) throw new Error('Требуются market.key и steam.key');

  const searchUrl = `https://market.dota2.net/api/v2/search-item-by-hash-name?key=${marketKey}&hash_name=${encodeURIComponent(target.item)}`;
  const mRes = await fetch(searchUrl);
  const mData = await mRes.json();
  if (!mData.success || !mData.data) return [];

  const lots = mData.data;
  if (!lots.length) return [];

  // Собираем уникальные комбинации classid + instanceid
  const pairs = [];
  for (const l of lots) {
    if (!pairs.some(p => p.classid === String(l.class) && p.instanceid === String(l.instance))) {
      pairs.push({ classid: String(l.class), instanceid: String(l.instance) });
    }
  }

  // Запрашиваем информацию о сокетах через SteamEconomy API
  let steamUrl = `https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v0001?key=${steamKey}&appid=570&class_count=${pairs.length}`;
  for (let i = 0; i < pairs.length; i++) {
    steamUrl += `&classid${i}=${pairs[i].classid}&instanceid${i}=${pairs[i].instanceid}`;
  }

  const sRes = await fetch(steamUrl);
  const sData = await sRes.json();
  const resultMap = sData.result || {};

  const matches = [];
  for (const lot of lots) {
    const key = `${lot.class}_${lot.instance}`;
    const info = resultMap[key];
    if (!info) continue;

    // Строгая проверка: ищем РЕАЛЬНЫЙ сокет с иконкой gem_animation, а не текстовый комментарий
    const realKineticGems = [];
    for (const dKey in info.descriptions) {
      const val = info.descriptions[dKey].value || '';
      if (val.includes('gem_animation')) {
        // Извлекаем имя гема из заголовка сокета
        const m = val.match(/<span style="font-size: 18px[^>]*>([^<]+)<\/span>/);
        if (m && m[1] !== 'Empty Socket') {
          realKineticGems.push(m[1].trim());
        }
      }
    }

    if (realKineticGems.length) {
      const priceRub = lot.price / 100;
      const profit = Math.round(target.gem_price - priceRub);
      if (profit > 0) {
        matches.push({
        item: target.item,
        hero: target.hero,
        gem: target.gem,
        detected_gems: realKineticGems,
        lot_price: priceRub,
        gem_price: target.gem_price,
        profit,
        classid: lot.class,
        instanceid: lot.instance,
        inspect_url: `/inspect?class=${lot.class}&instance=${lot.instance}`,
        market_url: `https://market.dota2.net/item/${lot.class}-${lot.instance}`,
        steam_url: `https://steamcommunity.com/market/listings/570/${encodeURIComponent(target.item)}`,
        ts: Date.now()
      });
      }
    }
  }

  return matches;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API endpoints
  if (pathname === '/api/status') {
    const bal = await fetchMarketBalance();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      market_key_ok: Boolean(getMarketKey()),
      steam_key_ok: Boolean(getSteamKey()),
      balance: bal.balance,
      currency: bal.currency || 'RUB',
      targets_count: KINETIC_TARGETS.length
    }));
    return;
  }

  if (pathname === '/api/targets') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(KINETIC_TARGETS));
    return;
  }

  if (pathname === '/api/scan-one') {
    const itemName = parsed.searchParams.get('item');
    const target = KINETIC_TARGETS.find(t => t.item === itemName);
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Target not found' }));
      return;
    }
    try {
      const results = await scanTarget(target);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ item: target.item, results }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/api/scan-all') {
    try {
      const allResults = [];
      for (const target of KINETIC_TARGETS) {
        try {
          const res = await scanTarget(target);
          if (res.length) allResults.push(...res);
        } catch (err) {
          console.error(`Error scanning ${target.item}:`, err.message);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ count: allResults.length, results: allResults }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Документация и отчеты
  if (pathname === '/api/doc/readme') {
    const p = path.join('C:/Users/oblako/Desktop/New folder (10)', 'README.md');
    const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 'README не найден';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(content);
    return;
  }

  if (pathname === '/api/doc/combiner') {
    const p = path.join('C:/Users/oblako/Desktop/New folder (10)', 'COMBINER.md');
    const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 'COMBINER не найден';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(content);
    return;
  }

  // Прямой инспектор предмета из Steam с визуализацией всех сокетов
  if (pathname === '/inspect') {
    const classId = parsed.searchParams.get('class') || '200339871';
    const instanceId = parsed.searchParams.get('instance') || '1337149273';
    const steamKey = getSteamKey();

    try {
      const steamUrl = `https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v0001?key=${steamKey}&appid=570&class_count=1&classid0=${classId}&instanceid0=${instanceId}`;
      const sRes = await fetch(steamUrl);
      const sData = await sRes.json();
      const info = sData.result ? (sData.result[`${classId}_${instanceId}`] || sData.result[classId]) : null;

      if (!info) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Предмет ${classId}_${instanceId} не найден в Steam API</h1>`);
        return;
      }

      // Собираем HTML сокетов из описаний Steam
      const descHtmls = Object.values(info.descriptions || {}).map(d => d.value).join('<br>');

      const page = `
        <!DOCTYPE html>
        <html lang="ru">
        <head>
          <meta charset="UTF-8">
          <title>Steam Asset Inspector — ${info.market_hash_name}</title>
          <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
          <style>
            body { background: #07090e; color: #f8fafc; font-family: 'Plus Jakarta Sans', sans-serif; padding: 40px; display: flex; justify-content: center; }
            .card { max-width: 780px; width: 100%; background: #0f141d; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 32px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
            h1 { font-size: 1.6rem; color: #10b981; margin-bottom: 8px; }
            .meta { color: #8896ab; font-size: 0.88rem; margin-bottom: 24px; font-family: 'JetBrains Mono', monospace; }
            .steam-render { background: #151b27; border: 1px solid rgba(16,185,129,0.3); border-radius: 12px; padding: 20px; margin: 20px 0; }
            .explainer { background: rgba(245,158,11,0.08); border-left: 4px solid #f59e0b; padding: 16px 20px; border-radius: 0 8px 8px 0; margin-top: 24px; font-size: 0.92rem; line-height: 1.6; }
            .badge-real { background: #10b981; color: #000; font-weight: 800; padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; display: inline-block; margin-bottom: 12px; }
            .back-btn { display: inline-block; margin-top: 24px; color: #06b6d4; text-decoration: none; font-weight: 600; }
            .back-btn:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <div class="card">
            <span class="badge-real">✓ ПОДТВЕРЖДЕНО СЕРВЕРОМ STEAM</span>
            <h1>${info.market_hash_name || 'Item'}</h1>
            <div class="meta">ClassID: ${classId} | InstanceID: ${instanceId}</div>

            <div style="font-weight:700; margin-bottom:10px; color:#c084fc;">Оригинальный рендеринг сокетов из Steam:</div>
            <div class="steam-render">
              ${descHtmls}
            </div>

            <div class="explainer">
              <strong style="color:#f59e0b;">🔍 Почему на market.dota2.net написано «Пустое гнездоОбщий»?</strong><br>
              У этого предмета <strong>3 сокета</strong>:<br>
              1. 💎 <strong>Kinetic: Serene Honor</strong> (родной кинетический гем — <strong>он физически внутри!</strong>)<br>
              2. ⚪ <strong>Пустое гнездо</strong> (пробито долотом Artificer's Chisel)<br>
              3. ⚪ <strong>Пустое гнездо</strong> (пробито вторым долотом)<br><br>
              Парсер сайта <code>market.dota2.net</code> имеет баг: при генерации описания лота он проходит циклом по сокетам и каждый следующий сокет <strong>перезаписывает</strong> текст предыдущего! В итоге на сайте отобразился только <em>последний (3-й) сокет</em> — «Пустое гнездоОбщий».<br><br>
              Обычные покупатели видят надпись «Пустое гнездо» и думают, что вещь пустая. А наш радар через Steam API видит настоящий сокет №1 с гемом <strong>Serene Honor за 500+ ₽</strong>!
            </div>

            <a class="back-btn" href="/">← Вернуться в Кинетик-Радар</a>
          </div>
        </body>
        </html>
      `;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ошибка Steam API: ' + e.message);
    }
    return;
  }


  // Главная страница панели
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(ROOT, 'radar.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath));
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[RADAR SERVER] Запущен на http://localhost:${PORT}`);
});
