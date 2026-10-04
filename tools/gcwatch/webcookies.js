// Веб-куки Steam по сохранённой сессии — для чтения своей истории рынка.
//
//   node webcookies.js --token token-web-main.json --platform web
//   node webcookies.js --token token.json --check   (устарело, см. ниже)
//
// С 2025-04-30 Steam отвечает AccessDenied на getWebCookies() и
// refreshAccessToken() для SteamClient-токена вне CM-сессии (документация
// steam-session). Поэтому куки — только из отдельного WebBrowser-токена
// (--platform web, вход — weblogin.js). Игровой токен сюда не годится.
//
// Входа в сеть Steam здесь нет: steam-session обменивает веб-токен на
// куки steamcommunity.com (finalizelogin), не открывая сессии клиента. Игра
// и отправщик на том же аккаунте не выбиваются.
//
// Куки печатаются одной строкой «COOKIES <json>» в stdout — их читает панель,
// держит в памяти и никуда не пишет. Это ключ к веб-аккаунту: вывод не
// сохраняйте и не показывайте.

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const TOKEN_FILE = path.resolve(__dirname, opt('--token', 'token.json'));
const CHECK = argv.includes('--check');
const WEB = opt('--platform', 'client') === 'web';

async function main() {
  let refreshToken;
  try { refreshToken = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).refreshToken; }
  catch (e) { throw new Error('нет сессии ' + path.basename(TOKEN_FILE) + ' — привяжите аккаунт по QR'); }
  if (!refreshToken) throw new Error('в ' + path.basename(TOKEN_FILE) + ' нет refresh-токена');

  const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
  const session = new LoginSession(WEB ? EAuthTokenPlatformType.WebBrowser : EAuthTokenPlatformType.SteamClient);
  session.refreshToken = refreshToken;

  // Проверка сессии: обмен на access-токен. Отозванный токен Steam
  // встречает AccessDenied — так же, как встретил бы отправщика.
  if (CHECK) {
    try { await session.refreshAccessToken(); process.stdout.write('SESSION ok\n'); }
    catch (e) {
      const denied = /AccessDenied|Revoked|Expired|InvalidSignature/i.test(String(e && e.message));
      process.stdout.write('SESSION ' + (denied ? 'revoked' : 'error') + ' ' + String(e && e.message || e) + '\n');
    }
    process.exit(0);
  }

  const cookies = await session.getWebCookies();
  process.stdout.write('COOKIES ' + JSON.stringify(cookies) + '\n');
  // steam-session держит сетевые ручки открытыми — выходим явно.
  process.exit(0);
}

main().catch(e => {
  console.error('ERROR ' + String(e && e.message || e));
  process.exit(1);
});
