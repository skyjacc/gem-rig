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
const { mergeLedger, effectiveDelay, validateRow, createTracker,
        classifyError, isRecoverable, retryDelay } = require('./lib.js');

const EMsg = { CacheSubscribed: 24, UpdateMultiple: 26, ClientWelcome: 4004, ClientHello: 4006, UpgradeLeagueItem: 7203, UpgradeResponse: 7204, WatchDownloadedReplay: 7206 };
const APPID = 570;
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// Сессия аккаунта. По умолчанию token.json — первый и единственный аккаунт.
// Для второго и третьего передаётся --token token-<метка>.json: у каждого
// аккаунта своя сессия, свой журнал расхода и свой процесс.
const TOKEN_FILE = path.resolve(__dirname, opt('--token', 'token.json'));

const DRY = flag('--dry') || !flag('--send');
const DELAY = Number(opt('--delay', 2000));
const DELAY_GIVEN = flag('--delay');
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

// --no-resume влияет только на то, что ПРОПУСКАЕТСЯ в этом прогоне.
// На содержимое файла он больше не влияет: запись всегда идёт слиянием.
function readLedgerFile() {
  if (!IDS_FILE || !fs.existsSync(ledgerFile())) return [];
  try { return JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')); }
  catch (e) { return []; }
}

function loadLedger() {
  if (!RESUME) return new Set();
  return new Set(readLedgerFile());
}

// Пишем слиянием с тем, что уже на диске: --no-resume и параллельный прогон
// больше не стирают чужие записи. Так уже потерялись 8 матчей из 23.
function saveLedger(set) {
  if (!IDS_FILE) return;
  fs.writeFileSync(ledgerFile(), JSON.stringify(mergeLedger(readLedgerFile(), [...set])));
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
  // Метка для панели: она рисует этот же код у себя, чтобы не заставлять
  // человека искать окно терминала.
  console.log('QRURL ' + start.qrChallengeUrl);

  session.on('remoteInteraction', () => console.log('телефон увидел код, подтверди вход'));

  return new Promise((resolve, reject) => {
    session.on('authenticated', () => {
      console.log('вход подтверждён:', session.accountName);
      if (SAVE_TOKEN) {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken: session.refreshToken }, null, 2));
        console.log('сессия записана в ' + path.basename(TOKEN_FILE) + ' — это ключ от аккаунта, никуда не выкладывай');
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
  let fromFile = null;
  try { fromFile = Number(fs.readFileSync(DELAY_FILE, 'utf8').trim()); }
  catch (e) { /* нет файла — работаем на --delay */ }
  return effectiveDelay(DELAY_GIVEN, DELAY, fromFile);
}

// Живое состояние для панели. Пишется из report(), когда GC действительно
// ответил, а не по таймеру — см. createTracker в lib.js.
// Отчёт о ходе работы. У каждого аккаунта свой файл: два отправщика,
// пишущие в один status.json, затирали бы друг друга.
const STATUS_FILE = path.resolve(__dirname, opt('--status', 'status.json'));

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
    // Печатаем действующую паузу, а не флаг: раньше шапка показывала --delay,
    // хотя прожиг шёл по значению из delay.txt, и темп в логе был ложью.
    console.log('режим: отправка ' + MSG + ', ' + ids.length + ' матчей, пауза ' + currentDelay() + ' мс');
    console.log('расчётное время: ' + hhmm(ids.length * currentDelay()));
  }

  let SteamUser;
  try { SteamUser = require('steam-user'); }
  catch (e) { throw new Error('нет зависимостей: выполни npm i в папке tools/gcwatch'); }

  const user = new SteamUser({ autoRelogin: true });
  let SAVED_LOGIN = null, SAVED_PASS = null;
  let gcReady = false;
  let updates = 0, responses = 0, lastBytes = 0;
  const other = new Map();   // прочие сообщения GC — чтобы видеть, если появится что-то новое

  // Сопоставление ответов с отправками вместо «вырос ли счётчик за паузу».
  // Пауза теперь только темп, к учёту отношения не имеет.
  const tracker = createTracker();
  const tally = { update: 0, dup: 0, silent: 0 };
  const lat = [];          // задержки 7204, для замера безопасного темпа
  const credLat = [];      // задержки msg 26 — они и определяют минимальную паузу
  let resolved = 0, total = 0, startedAt = 0;
  const recent = [];

  function report(r) {
    tally[r.result]++;
    resolved++;
    if (r.latency !== null) lat.push(r.latency);
    if (r.creditLatency !== null) credLat.push(r.creditLatency);

    const mark = r.result === 'update' ? 'ОБНОВЛЕНО, ' + r.bytes + ' байт'
      : r.result === 'dup' ? 'ответ есть, обновления нет'
      : 'ТИШИНА — GC не ответил';
    const num = String(resolved).padStart(String(total).length, ' ');
    console.log('  [' + num + '/' + total + '] match ' + r.match +
      '  лига ' + (r.league || '—') + '  -> ' + mark +
      (r.creditLatency !== null ? '   +' + r.creditLatency + ' мс' : '') +
      '   | ' + tally.update + ' обн, ' + tally.dup + ' дубл, ' + tally.silent + ' тишина');

    recent.unshift({
      n: resolved, total, match: r.match, league: r.league, result: r.result, bytes: r.bytes,
      latency: r.latency, creditLatency: r.creditLatency,
      updates, responses, delay: currentDelay(), startedAt, ts: Date.now(),
      other: [...other].map(x => ({ type: x[0], count: x[1] })),
    });
    if (recent.length > 40) recent.pop();
    try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ current: recent[0], recent, tally, lat, credLat }, null, 2)); }
    catch (e) { /* панель переживёт */ }
  }

  if (USE_PASSWORD) {
    const accountName = await ask('Steam логин: ', false);
    const password = await ask('Пароль (ввод скрыт): ', true);
    SAVED_LOGIN = accountName; SAVED_PASS = password;
    user.logOn({ accountName, password, machineName: 'gcwatch' });
    user.on('steamGuard', async (domain, callback) => {
      const code = await ask(domain ? 'Код Steam Guard с почты (' + domain + '): ' : 'Код мобильного Steam Guard: ', false);
      callback(code);
    });
  } else {
    user.logOn({ refreshToken: await qrRefreshToken() });
  }

  // Ошибки Steam делятся на восстановимые и фатальные. Раньше процесс падал
  // на любой, хотя autoRelogin включён — шанса ему не давали, и одно
  // обновление сессии десктопным клиентом обрывало весь многочасовой прогон.
  let attempt = 0;
  let reviving = false;

  user.on('error', e => {
    const kind = classifyError(e.message);

    if (kind === 'stale-token') {
      if (!USE_PASSWORD && fs.existsSync(TOKEN_FILE)) {
        fs.unlinkSync(TOKEN_FILE);
        console.error('сохранённая сессия протухла, удалил ' + path.basename(TOKEN_FILE) + ' — запусти ещё раз, покажу QR');
      } else {
        console.error('вход отклонён:', e.message);
      }
      return process.exit(1);
    }

    if (!isRecoverable(e.message)) {
      console.error('ошибка Steam:', e.message);
      return process.exit(1);
    }

    // Восстановимое: ждём и входим заново. Отправка сама встанет на waitGC.
    gcReady = false;
    if (reviving) return;

    // Потолок попыток. Если Steam открыт и держит сессию — он будет выбивать
    // бесконечно, и лучше остановиться с внятной причиной, чем крутиться.
    if (attempt >= 6) {
      console.error();
      console.error('шесть попыток входа подряд отбиты. Скорее всего открыт Steam —');
      console.error('он периодически подтверждает свою сессию и выбивает бота.');
      console.error('Закрой Steam и Dota и запусти снова: отправленное уже в журнале.');
      return process.exit(1);
    }

    reviving = true;
    const wait = retryDelay(attempt, kind);
    attempt++;
    const why = kind === 'displaced' ? 'выбило другой сессией Steam'
      : kind === 'rate-limit' ? 'Steam ограничил частоту входов'
        : 'связь оборвалась';
    console.log('  ! ' + why + ' (' + e.message + '). Жду ' +
      Math.round(wait / 1000) + ' с и вхожу заново, попытка ' + attempt);

    setTimeout(async () => {
      reviving = false;
      try {
        if (USE_PASSWORD) user.logOn({ accountName: SAVED_LOGIN, password: SAVED_PASS, machineName: 'gcwatch' });
        else user.logOn({ refreshToken: await qrRefreshToken() });
      } catch (err) {
        console.error('  ! повторный вход не удался:', err.message);
      }
    }, wait);
  });

  // Успешный вход обнуляет счётчик попыток: следующий обрыв начнёт
  // отсчёт заново, а не с пятиминутной паузы.
  user.on('loggedOn', () => { attempt = 0; });
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
    console.log('STEAMID ' + user.steamID.getSteamID64());
    // Invisible, а не Online: снаружи аккаунт выглядит оффлайн, друзья не видят
    // ни статуса, ни «играет в Dota 2». На GC это не влияет — соединение с ним
    // держится через gamesPlayed, а не через статус присутствия.
    user.setPersona(SteamUser.EPersonaState.Invisible);
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
    if (type === EMsg.UpdateMultiple) {
      updates++; lastBytes = payload.length;
      tracker.onUpdate(Date.now(), payload.length);
      return;
    }
    if (type === EMsg.UpgradeResponse) {
      responses++;
      const r = tracker.onResponse(Date.now());
      if (r) report(r);
      return;
    }
    other.set(type, (other.get(type) || 0) + 1);
  });

  // Ждём Welcome от GC, но не бесконечно. Открытый Steam-клиент занимает
  // единственную сессию аккаунта, и раньше отправщик в этом случае висел молча:
  // процесс жив, панель зелёная, в логе тишина. Выглядело как «накрутка сломалась».
  // Щедро: восстановление после выбивания растёт до пяти минут, и таймаут
  // не должен срабатывать посреди него. Безнадёжный случай ловится не здесь,
  // а счётчиком попыток входа — см. обработчик ошибок.
  const GC_TIMEOUT = 15 * 60_000;
  const waitGC = () => new Promise((resolve, reject) => {
    if (gcReady) return resolve();
    const started = Date.now();
    const t = setInterval(() => {
      if (gcReady) { clearInterval(t); return resolve(); }
      if (Date.now() - started > GC_TIMEOUT) {
        clearInterval(t);
        reject(new Error('GC не ответил Welcome за 90 секунд — закрой Steam и Dota, они занимают сессию'));
      }
    }, 1000);
  });

  await waitGC();

  if (DRY) {
    console.log('сухой прогон окончен. Для отправки: --ids <файл> --send');
    user.logOff();
    return setTimeout(() => process.exit(0), 1000);
  }

  const started = Date.now();
  startedAt = started;
  total = ids.length;
  // Сколько ждать ответа, прежде чем признать отправку безответной.
  const GRACE = 15_000;

  for (let i = 0; i < ids.length; i++) {
    await waitGC();
    const row = ids[i];
    const bad = validateRow(row);
    if (bad) { console.log('  пропуск ' + row.match + ': ' + bad); total--; continue; }

    if (MSG === 'watch') user.sendToGC(APPID, EMsg.WatchDownloadedReplay, {}, encodeWatch(row.match));
    else user.sendToGC(APPID, EMsg.UpgradeLeagueItem, {}, encodeUpgrade(row.match, row.league));

    ledger.add(row.match);
    saveLedger(ledger);   // каждый матч, иначе перезапуск теряет отправленное
    tracker.send(row.match, row.league, Date.now());

    // Пауза — это ТЕМП, а не измеритель. Отчёт придёт из обработчика 7204,
    // когда GC действительно ответит, сколько бы это ни заняло.
    await new Promise(r => setTimeout(r, currentDelay()));

    // Подчищаем то, на что GC не ответил вовсе. Это «не знаем», а не «сожжён».
    for (const dead of tracker.expire(Date.now(), GRACE)) report(dead);
  }

  // Ждём хвост: последние отправки могли ещё не получить ответа.
  const tailStart = Date.now();
  while (tracker.outstanding() > 0 && Date.now() - tailStart < GRACE + 5000) {
    await new Promise(r => setTimeout(r, 500));
    for (const dead of tracker.expire(Date.now(), GRACE)) report(dead);
  }


  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
  const pct = (a, p) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };

  console.log();
  console.log('готово за ' + hhmm(Date.now() - started));
  console.log('  отправлено ' + ids.length + ':  обновлений ' + tally.update +
    ', дублей ' + tally.dup + ', тишины ' + tally.silent);
  if (credLat.length) {
    console.log('  задержка начисления (msg 26): среднее ' + avg(credLat) +
      ' мс, медиана ' + pct(credLat, 0.5) +
      ', 95-й процентиль ' + pct(credLat, 0.95) +
      ', максимум ' + Math.max(...credLat));
    console.log('  ↑ безопасная пауза должна быть больше 95-го процентиля');
  }
  if (lat.length) {
    console.log('  задержка ответа (7204): среднее ' + avg(lat) + ' мс, максимум ' + Math.max(...lat));
  }
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

    for (const row of rows) {
      await waitGC();
      const bad = validateRow(row);
      if (bad) { console.log('  очередь: пропуск ' + row.match + ' — ' + bad); done.add(row.match); continue; }

      if (MSG === 'watch') user.sendToGC(APPID, EMsg.WatchDownloadedReplay, {}, encodeWatch(row.match));
      else user.sendToGC(APPID, EMsg.UpgradeLeagueItem, {}, encodeUpgrade(row.match, row.league));

      done.add(row.match);
      ledger.add(row.match);
      total++;
      // Отчёт придёт из обработчика 7204 — здесь только темп.
      tracker.send(row.match, row.league, Date.now());

      // Темп меняется на лету: положи число миллисекунд в delay.txt рядом со скриптом.
      await new Promise(r => setTimeout(r, currentDelay()));
      for (const dead of tracker.expire(Date.now(), 15_000)) report(dead);

      saveLedger(ledger);
    }
    if (rows.length) saveLedger(ledger);
  }
}

main().catch(e => { console.error('ошибка:', e.message); process.exit(1); });
