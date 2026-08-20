// gcwatch — шлёт в Dota 2 Game Coordinator сообщение, которым клиент засчитывает матч гему.
//
//   node index.js --dry --save-token                   вход по QR, сессия сохраняется
//   node index.js --ids navi.csv --send --limit 10
//   node index.js --ids empire.csv --send --limit 1000 --delay 18000
//   node index.js --ids empire.csv --send --no-resume  не пропускать уже отправленные
//   node index.js --ids ... --send --password          вход логином и паролем вместо QR
//
// Долгий прогон переживает разрывы: steam-user переподключается сам, скрипт ждёт,
// пока GC снова ответит Welcome, и продолжает с того же места. Отправленные match_id
// пишутся в sent-<файл>.json, поэтому перезапуск не тратит их заново.
//
// Сообщение подсмотрено в console.log живого клиента при playdemo:
//   [GCClient] Send msg 7203 (k_EMsgUpgradeLeagueItem), 27 bytes
//   [GCClient] Recv msg 26 (k_ESOMsg_UpdateMultiple)          <- предметы обновились
//   [GCClient] Recv msg 7204 (k_EMsgUpgradeLeagueItemResponse)
//
//   k_EMsgUpgradeLeagueItem = 7203
//   message CMsgUpgradeLeagueItem { optional uint64 match_id = 1; optional uint32 league_id = 2; }
//
// GC сам смотрит, кто играл в матче, и повышает все подходящие гемы разом.
// Матч засчитывается предмету один раз: повтор даёт 7204 без 26.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const EMsg = { CacheSubscribed: 24, UpdateMultiple: 26, ClientWelcome: 4004, ClientHello: 4006, UpgradeLeagueItem: 7203, UpgradeResponse: 7204, WatchDownloadedReplay: 7206 };
const APPID = 570;
const TOKEN_FILE = path.join(__dirname, 'token.json');

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DRY = flag('--dry') || !flag('--send');
const DELAY = Number(opt('--delay', 2000));
const LIMIT = Number(opt('--limit', 0));
const IDS_FILE = opt('--ids', null);
const MSG = opt('--msg', 'upgrade');        // upgrade | watch
const SAVE_TOKEN = !flag('--no-save-token');
const RESUME = !flag('--no-resume');
const KEEP_ALIVE = flag('--keep-alive');
const QUEUE_FILE = opt('--queue', path.join(__dirname, 'queue.csv'));

// QR требует steam-session и qrcode-terminal. Нет их — уходим на логин с паролем,
// чтобы обновление зависимостей не ломало рабочий запуск.
function qrAvailable() {
  try { require.resolve('steam-session'); require.resolve('qrcode-terminal'); return true; }
  catch (e) { return false; }
}
const USE_PASSWORD = flag('--password') || !qrAvailable();

// --- protobuf вручную: varint-поля, зависимостей не нужно ---
function varint(v) {
  const out = [];
  let n = BigInt(v);
  while (n >= 0x80n) { out.push(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
  out.push(Number(n));
  return Buffer.from(out);
}

// CMsgUpgradeLeagueItem { match_id = 1, league_id = 2 }
function encodeUpgrade(matchId, leagueId) {
  const parts = [Buffer.from([0x08]), varint(matchId)];
  if (leagueId) parts.push(Buffer.from([0x10]), varint(leagueId));
  return Buffer.concat(parts);
}

// CMsgGCWatchDownloadedReplay { match_id = 1 }
function encodeWatch(matchId) {
  return Buffer.concat([Buffer.from([0x08]), varint(matchId)]);
}

// PowerShell 5.1 через > пишет UTF-16LE с BOM — кодировку определяем по сигнатуре.
function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

const ledgerFile = () => path.join(__dirname, 'sent-' + path.basename(IDS_FILE || 'none') + '.json');

function loadLedger() {
  if (!RESUME || !IDS_FILE || !fs.existsSync(ledgerFile())) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'))); }
  catch (e) { return new Set(); }
}

function saveLedger(set) {
  if (!IDS_FILE) return;
  fs.writeFileSync(ledgerFile(), JSON.stringify([...set]));
}

function loadIds(ledger) {
  if (!IDS_FILE) return [];
  const rows = readText(IDS_FILE).split(String.fromCharCode(10))
    .map(l => l.trim()).filter(l => /^[0-9]{6,}/.test(l))
    .map(l => { const [m, lg] = l.split(','); return { match: m.trim(), league: (lg || '').trim() }; })
    .filter(r => !ledger.has(r.match));
  return LIMIT ? rows.slice(0, LIMIT) : rows;
}

function ask(question, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!hidden) return rl.question(question, a => { rl.close(); resolve(a.trim()); });
    process.stdout.write(question);
    const onData = () => {
      readline.moveCursor(process.stdout, -1000, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write(question + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
    rl.question('', a => { process.stdin.removeListener('data', onData); rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

// --- вход по QR через приложение Steam ---
async function qrRefreshToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (saved.refreshToken) { console.log('вхожу по сохранённой сессии, QR не нужен'); return saved.refreshToken; }
    } catch (e) { /* битый файл — просто пересоздадим */ }
  }

  const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
  const qrcode = require('qrcode-terminal');
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);

  const start = await session.startWithQR();
  console.log('\nПриложение Steam на телефоне -> значок QR справа сверху -> наведи камеру:\n');
  qrcode.generate(start.qrChallengeUrl, { small: true });
  console.log('\nссылка, если код не читается:');
  console.log(start.qrChallengeUrl + '\n');

  session.on('remoteInteraction', () => console.log('телефон увидел код, подтверди вход'));

  return new Promise((resolve, reject) => {
    session.on('authenticated', () => {
      console.log('вход подтверждён:', session.accountName);
      if (SAVE_TOKEN) {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken: session.refreshToken }, null, 2));
        console.log('сессия записана в token.json — это ключ от аккаунта, никуда не выкладывай');
      }
      resolve(session.refreshToken);
    });
    session.on('timeout', () => reject(new Error('QR протух, запусти заново')));
    session.on('error', e => reject(e));
  });
}

// Темп в режиме очереди: число миллисекунд в delay.txt перекрывает --delay без перезапуска.
const DELAY_FILE = path.join(__dirname, 'delay.txt');
function currentDelay() {
  try {
    const v = Number(fs.readFileSync(DELAY_FILE, 'utf8').trim());
    if (Number.isFinite(v) && v >= 500) return v;
  } catch (e) { /* нет файла — работаем на --delay */ }
  return DELAY;
}

// Живое состояние для панели: последние события и общий счёт.
const STATUS_FILE = path.join(__dirname, 'status.json');
const recent = [];
function writeStatus(ev) {
  recent.unshift(ev);
  if (recent.length > 40) recent.pop();
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ current: ev, recent }, null, 2)); }
  catch (e) { /* панель переживёт */ }
}

function hhmm(ms) {
  const m = Math.round(ms / 60000);
  return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
}

async function main() {
  const ledger = loadLedger();
  const ids = loadIds(ledger);

  if (DRY) console.log('режим: сухой прогон, ничего не отправляется');
  else {
    if (!ids.length) throw new Error(ledger.size ? 'все матчи из файла уже отправлены (см. ' + path.basename(ledgerFile()) + ')' : 'нет match_id — передай --ids <файл>');
    if (ledger.size) console.log('в журнале уже ' + ledger.size + ' отправленных, они пропущены');
    console.log('режим: отправка ' + MSG + ', ' + ids.length + ' матчей, пауза ' + DELAY + ' мс');
    console.log('расчётное время: ' + hhmm(ids.length * DELAY));
  }

  let SteamUser;
  try { SteamUser = require('steam-user'); }
  catch (e) { throw new Error('нет зависимостей: выполни npm i в папке tools/gcwatch'); }

  const user = new SteamUser({ autoRelogin: true });
  let gcReady = false;
  let updates = 0, responses = 0, lastBytes = 0;
  const other = new Map();   // прочие сообщения GC — чтобы видеть, если появится что-то новое

  if (USE_PASSWORD) {
    const accountName = await ask('Steam логин: ', false);
    const password = await ask('Пароль (ввод скрыт): ', true);
    user.logOn({ accountName, password, machineName: 'gcwatch' });
    user.on('steamGuard', async (domain, callback) => {
      const code = await ask(domain ? 'Код Steam Guard с почты (' + domain + '): ' : 'Код мобильного Steam Guard: ', false);
      callback(code);
    });
  } else {
    user.logOn({ refreshToken: await qrRefreshToken() });
  }

  user.on('error', e => {
    // Протухший refreshToken выглядит как отказ входа — сносим его, чтобы следующий запуск дал QR.
    const stale = /InvalidPassword|AccessDenied|Expired|InvalidSignature/i.test(e.message || '');
    if (stale && !USE_PASSWORD && fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
      console.error('сохранённая сессия протухла, удалил token.json — запусти ещё раз, покажу QR');
    } else {
      console.error('ошибка Steam:', e.message);
    }
    process.exit(1);
  });
  user.on('disconnected', (eresult, msg) => {
    gcReady = false;
    console.log('  ! связь потеряна (' + (msg || eresult) + '), жду переподключения');
  });

  let helloTimer = null;
  function hello() {
    user.sendToGC(APPID, EMsg.ClientHello, {}, Buffer.alloc(0));
    helloTimer = setTimeout(hello, 5000);
  }

  user.on('loggedOn', () => {
    console.log('вошёл как ' + user.steamID.getSteamID64());
    user.setPersona(SteamUser.EPersonaState.Online);
    user.gamesPlayed([APPID]);
    clearTimeout(helloTimer);
    setTimeout(hello, 1500);
  });

  user.on('receivedFromGC', (appid, type, payload) => {
    if (appid !== APPID) return;

    if (type === EMsg.ClientWelcome) {
      clearTimeout(helloTimer);
      if (!gcReady) console.log('GC ответил Welcome — сессия есть');
      gcReady = true;
      return;
    }
    if (type === EMsg.UpdateMultiple) { updates++; lastBytes = payload.length; return; }
    if (type === EMsg.UpgradeResponse) { responses++; return; }
    other.set(type, (other.get(type) || 0) + 1);
  });

  const waitGC = () => new Promise(resolve => {
    if (gcReady) return resolve();
    const t = setInterval(() => { if (gcReady) { clearInterval(t); resolve(); } }, 1000);
  });

  await waitGC();

  if (DRY) {
    console.log('сухой прогон окончен. Для отправки: --ids <файл> --send');
    user.logOff();
    return setTimeout(() => process.exit(0), 1000);
  }

  const started = Date.now();
  for (let i = 0; i < ids.length; i++) {
    await waitGC();
    const row = ids[i];
    const before = updates;

    if (MSG === 'watch') user.sendToGC(APPID, EMsg.WatchDownloadedReplay, {}, encodeWatch(row.match));
    else user.sendToGC(APPID, EMsg.UpgradeLeagueItem, {}, encodeUpgrade(row.match, row.league));

    ledger.add(row.match);
    saveLedger(ledger);   // каждый матч, иначе перезапуск теряет отправленное

    const n = i + 1;
    const num = String(n).padStart(String(ids.length).length, ' ');
    process.stdout.write('  [' + num + '/' + ids.length + '] match ' + row.match + '  лига ' + (row.league || '—') + '  -> отправлено, жду ответ');

    const beforeResp = responses;
    await new Promise(r => setTimeout(r, currentDelay()));

    const gotUpdate = updates > before;
    const mark = gotUpdate ? 'ОБНОВЛЕНО, ' + lastBytes + ' байт'
      : (responses > beforeResp ? 'ответ есть, обновления нет — матч уже засчитан аккаунту'
        : 'ТИШИНА — GC не ответил');
    const left = (ids.length - n) * currentDelay();

    process.stdout.write('\r  [' + num + '/' + ids.length + '] match ' + row.match + '  лига ' + (row.league || '—') + '  -> ' + mark
      + '   | прошло ' + hhmm(Date.now() - started) + ', осталось ' + hhmm(left) + '          \n');

    writeStatus({
      n, total: ids.length, match: row.match, league: row.league,
      result: gotUpdate ? 'update' : (responses > beforeResp ? 'dup' : 'silent'),
      bytes: gotUpdate ? lastBytes : 0,
      updates, responses, delay: currentDelay(),
      startedAt: started, ts: Date.now(),
      other: [...other].map(x => ({ type: x[0], count: x[1] })),
    });

    if (n % 25 === 0 || n === ids.length) {
      console.log('  --- итого: обновлений ' + updates + ' из ' + n + ', ответов ' + responses
        + (other.size ? ', прочие сообщения GC: ' + [...other].map(x => x[0] + '×' + x[1]).join(' ') : ''));
    }
  }

  console.log('готово. Матчей отправлено ' + ids.length + ', обновлений предметов ' + updates + ', ответов GC ' + responses);
  saveLedger(ledger);

  if (!KEEP_ALIVE) {
    setTimeout(() => { user.logOff(); setTimeout(() => process.exit(0), 1500); }, 8000);
    return;
  }

  // Держим одну сессию и разбираем очередь: Steam ограничивает частоту ВХОДОВ,
  // поэтому дешевле не выходить, чем логиниться на каждый тест.
  console.log('\nсессия остаётся открытой. Дописывай строки «match_id,league_id» в ' + QUEUE_FILE);
  console.log('они уйдут сами. Выход — Ctrl+C\n');

  const done = new Set();
  for (;;) {
    await new Promise(r => setTimeout(r, 3000));
    if (!fs.existsSync(QUEUE_FILE)) continue;

    const rows = readText(QUEUE_FILE).split(String.fromCharCode(10))
      .map(l => l.trim()).filter(l => /^[0-9]{6,}/.test(l))
      .map(l => { const [m, lg] = l.split(','); return { match: m.trim(), league: (lg || '').trim() }; })
      .filter(r => !done.has(r.match));

    let n = 0;
    for (const row of rows) {
      await waitGC();
      const before = updates;
      if (MSG === 'watch') user.sendToGC(APPID, EMsg.WatchDownloadedReplay, {}, encodeWatch(row.match));
      else user.sendToGC(APPID, EMsg.UpgradeLeagueItem, {}, encodeUpgrade(row.match, row.league));
      done.add(row.match);
      ledger.add(row.match);
      n++;

      // Темп меняется на лету: положи число миллисекунд в delay.txt рядом со скриптом.
      await new Promise(r => setTimeout(r, currentDelay()));

      const gotUpdate = updates > before;
      console.log('  очередь ' + n + '/' + rows.length + ': match ' + row.match + '  -> ' + (gotUpdate ? 'ОБНОВЛЕНО, ' + lastBytes + ' байт' : 'без обновления'));
      writeStatus({
        n, total: rows.length, match: row.match, league: row.league,
        result: gotUpdate ? 'update' : 'dup', bytes: gotUpdate ? lastBytes : 0,
        updates, responses, delay: currentDelay(), startedAt: started, ts: Date.now(),
        queue: true, other: [...other].map(x => ({ type: x[0], count: x[1] })),
      });
      saveLedger(ledger);
    }
    if (rows.length) saveLedger(ledger);
  }
}

main().catch(e => { console.error('ошибка:', e.message); process.exit(1); });
