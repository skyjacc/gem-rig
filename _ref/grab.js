// grab — тянет страницу целиком со всеми ассетами: js, css, svg, шрифты, картинки.
//
//   node _ref/grab.js https://osint-catalog.xyz https://osint-catalog.xyz/graph
//
// Кладёт всё в _ref/site/<host>/<путь>, сохраняя структуру.
// CSS разбирается рекурсивно: url(...) внутри стилей тоже скачивается.
// Внешние хосты (CDN, шрифты) сохраняются в свои папки.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'site');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const seen = new Set();
const queue = [];
let saved = 0, failed = 0;

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error('использование: node _ref/grab.js <url> [url...]');
  process.exit(1);
}

function localPath(u) {
  const url = new URL(u);
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  if (!path.extname(p)) p += '.html';
  // query отражаем в имени, чтобы ?v=1 не перетирал файл
  if (url.search) {
    const ext = path.extname(p);
    p = p.slice(0, -ext.length) + '__' + url.search.replace(/[^\w.-]+/g, '_') + ext;
  }
  return path.join(OUT, url.host, p);
}

function push(raw, base) {
  if (!raw) return;
  const s = raw.trim();
  if (!s || s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('#')) return;
  let u;
  try { u = new URL(s, base).href.split('#')[0]; } catch { return; }
  if (!/^https?:/.test(u)) return;
  if (seen.has(u)) return;
  seen.add(u);
  queue.push(u);
}

// ── извлечение ссылок ──
function fromHtml(html, base) {
  const attrs = /(?:src|href|data-src|poster)\s*=\s*["']([^"']+)["']/gi;
  for (const m of html.matchAll(attrs)) push(m[1], base);

  for (const m of html.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi))
    for (const part of m[1].split(',')) push(part.trim().split(/\s+/)[0], base);

  // Next.js и подобные прячут пути к чанкам в JSON внутри страницы
  for (const m of html.matchAll(/["'](\/_next\/[^"'\\]+|\/assets\/[^"'\\]+|\/static\/[^"'\\]+)["']/g))
    push(m[1], base);

  fromCss(html, base); // инлайновые <style> с url(...)
}

function fromCss(css, base) {
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) push(m[1], base);
  for (const m of css.matchAll(/@import\s+["']([^"']+)["']/gi)) push(m[1], base);
}

function fromJs(js, base) {
  // пути к ассетам, зашитые в бандлы
  for (const m of js.matchAll(/["'`](\/(?:_next|assets|static|icons|img|images|fonts)\/[^"'`\\\s]+)["'`]/g))
    push(m[1], base);
  for (const m of js.matchAll(/["'`]([\w./-]+\.(?:svg|png|jpe?g|webp|avif|gif|woff2?|ttf|otf|json))["'`]/gi))
    push(m[1], base);
}

async function grab(u) {
  let res;
  try {
    res = await fetch(u, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
  } catch (e) {
    failed++; console.log('  ✗ ' + e.message.slice(0, 60) + '  ' + u);
    return;
  }
  if (!res.ok) { failed++; console.log('  ✗ ' + res.status + '  ' + u); return; }

  const type = (res.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  const file = localPath(res.url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  saved++;
  console.log('  ✓ ' + String(buf.length).padStart(8) + '  ' + file.replace(OUT + path.sep, ''));

  const text = () => buf.toString('utf8');
  if (type.includes('html')) fromHtml(text(), res.url);
  else if (type.includes('css')) fromCss(text(), res.url);
  else if (type.includes('javascript') || type.includes('json')) fromJs(text(), res.url);
  else if (type.includes('svg')) fromCss(text(), res.url);
}

(async () => {
  roots.forEach(r => push(r, r));
  console.log('качаю в ' + OUT + '\n');
  while (queue.length) {
    const batch = queue.splice(0, 6);
    await Promise.all(batch.map(grab));
  }
  console.log(`\nготово. сохранено ${saved}, не удалось ${failed}`);
  console.log('структура:');
  const walk = (d, ind = '  ') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).slice(0, 40)) {
      console.log(ind + (e.isDirectory() ? '📁 ' : '   ') + e.name);
      if (e.isDirectory()) walk(path.join(d, e.name), ind + '  ');
    }
  };
  if (fs.existsSync(OUT)) walk(OUT);
})();
