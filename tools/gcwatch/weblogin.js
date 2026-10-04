// Веб-вход Steam по QR — отдельная сессия только для чтения сайта
// (план 3.3, задача 0). Игровой токен (token.json) НЕ трогается.
//
//   node weblogin.js --id main
//
// С 2025-04-30 веб-куки из SteamClient-токена вне CM-сессии не выдаются
// (документация steam-session); для WebBrowser-токена getWebCookies()
// поддерживается. Поэтому здесь — вход платформой WebBrowser и отдельный
// файл token-web-<id>.json (права только владельцу, закрыт .gitignore).
//
// Это ключ к веб-аккаунту: файл не выкладывать и не показывать.
// Входа в сеть Steam клиентом нет — игра и отправщик не выбиваются.

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ID = opt('--id', 'main');
if (!/^[a-z0-9-]{1,40}$/i.test(ID)) { console.error('ERROR плохой id аккаунта'); process.exit(1); }
const FILE = path.resolve(__dirname, 'token-web-' + ID + '.json');
const GAME = path.resolve(__dirname, 'token.json');

async function main() {
  const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
  const qrcode = require('qrcode-terminal');
  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
  const start = await session.startWithQR();
  console.log('\nВеб-вход (только чтение сайта Steam). Приложение Steam -> значок QR -> наведи камеру:\n');
  qrcode.generate(start.qrChallengeUrl, { small: true });
  console.log('\nссылка, если код не читается:');
  console.log(start.qrChallengeUrl + '\n');
  console.log('QRURL ' + start.qrChallengeUrl);
  session.on('remoteInteraction', () => console.log('телефон увидел код, подтверди вход'));

  await new Promise((resolve, reject) => {
    session.on('authenticated', () => {
      fs.writeFileSync(FILE, JSON.stringify({ refreshToken: session.refreshToken }, null, 2), { mode: 0o600 });
      console.log('вход подтверждён: ' + session.accountName);
      console.log('STEAMID ' + session.steamID.getSteamID64());
      console.log('веб-сессия записана в ' + path.basename(FILE) + ' — это ключ к веб-аккаунту, никуда не выкладывай');
      if (path.resolve(FILE) === path.resolve(GAME)) console.log('ОШИБКА: путь совпал с игровым токеном');
      resolve();
    });
    session.on('timeout', () => reject(new Error('QR протух, запусти заново')));
    session.on('error', e => reject(e));
  });
  process.exit(0);
}

main().catch(e => { console.error('ERROR ' + String(e && e.message || e)); process.exit(1); });
