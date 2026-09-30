// Чистые функции отправщика — вынесены сюда, чтобы их можно было проверить
// тестами. index.js без Steam-сессии не запускается, а эти две решают,
// что попадёт в журнал и с каким темпом пойдёт прожиг.

// Журнал отправленного.
//
// Раньше при --no-resume loadLedger возвращал пустое множество, а saveLedger
// писал файл целиком — второй прогон по тому же списку затирал историю первого.
// Так потерялись 8 записей из 23: sent-empire.csv.json содержит 5 строк, хотя
// в тот день по этому файлу ушло 10 матчей, и sent-batch100.csv.json — 2 из 5.
function mergeLedger(previous, sent) {
  return [...new Set([...previous, ...sent])];
}

// Темп прожига.
//
// Раньше delay.txt перекрывал --delay ВСЕГДА, поэтому явный флаг молча не
// работал: 20 августа прогон с --delay 60000 шёл по 300000 из файла, и это
// выглядело как зависание. Теперь флаг главнее, а файл нужен для смены темпа
// на лету, без перезапуска.
//
// Нижняя граница 500 мс общая для обоих источников: чаще нельзя, GC не успевает
// ответить, и настоящее начисление уедет за окно ожидания.
function effectiveDelay(flagWasGiven, flagValue, fileValue) {
  if (flagWasGiven && Number.isFinite(flagValue) && flagValue >= 500) return flagValue;
  if (Number.isFinite(fileValue) && fileValue >= 500) return fileValue;
  return flagValue;
}

// Проверка строки списка перед отправкой.
//
// league_id обязателен — проверено 20 августа. Матч 8003261364 без лиги
// вернул 7204 без обновления, он же с лигой 16710 дал ОБНОВЛЕНО и 507 байт.
// GC молча отвергает сообщение без второго поля, и снаружи отказ выглядит
// точно как дубль. Поэтому не отправляем вовсе, а не разбираемся потом.
function validateRow(row) {
  if (!row || !/^[0-9]{6,}$/.test(String(row.match || ''))) return 'нет match_id';
  if (!/^[0-9]{1,10}$/.test(String(row.league || ''))) return 'нет league_id — GC отвергнет молча';
  return null;
}

// Сопоставление ответов GC с конкретными отправками.
//
// Раньше успех определялся так: запомнить глобальный счётчик msg 26, поспать
// ровно delay, посмотреть, вырос ли он. Два изъяна.
//
// Первый: окно равно паузе. Ответ, пришедший на миллисекунду позже, читался
// как «тишина», хотя начисление произошло.
//
// Второй, хуже: счётчик перечитывался на каждой итерации, поэтому опоздавший
// msg 26 доставался СЛЕДУЮЩЕМУ матчу. Атрибуция не просто теряла события,
// она их переставляла.
//
// Здесь по-другому. Наблюдаемый порядок в GC: 7203 → msg 26 → 7204, причём
// 7204 приходит ровно один на отправку, а msg 26 — ноль или один. Значит
// очередь FIFO сопоставляет их надёжно и без всяких окон.
//
// Пауза после этого становится тем, чем и должна быть: темпом, а не измерителем.
//
// Опоздание и потеря — разные вещи.
//
// Раньше отправка без ответа за 15 секунд закрывалась насовсем, и её 7204,
// пришедший позже, закрывал уже СЛЕДУЮЩУЮ отправку. Дальше весь прогон
// ехал со сдвигом на одну: ответ B записывался матчу C, начисление C — D.
//
// Теперь безответная отправка помечается «тишиной», но место в очереди
// держит: опоздавший ответ достаётся ей, и отчёт уточняется. Выбрасывается
// она только когда ответ точно не придёт — связь с GC оборвалась (lost)
// или прошло столько, сколько GC не отвечает никогда (LOST_MS).
const LOST_MS = 120_000;

function createTracker() {
  let pending = [];

  const open = p => !p.answered;
  const prune = () => { while (pending.length && pending[0].answered) pending.shift(); };

  return {
    send(match, league, at) {
      pending.push({
        match, league, sentAt: at, credited: false, bytes: 0, updateAt: null,
        answered: false, expired: false,
      });
    },

    // msg 26 — начисление произошло. Достаётся самой старой отправке,
    // которая ещё не получила ни ответа, ни обновления.
    onUpdate(at, bytes, so = null) {
      const p = pending.find(x => open(x) && !x.credited);
      if (!p) return;
      p.credited = true;
      p.bytes = bytes;
      p.updateAt = at;
      p.so = so;
    },

    // 7204 — GC отработал сообщение. Закрывает самую старую отправку без
    // ответа, в том числе уже объявленную тишиной: тогда это опоздание,
    // и отчёт по ней уточняется (late).
    onResponse(at) {
      const p = pending.find(open);
      if (!p) return null;
      p.answered = true;
      prune();
      return {
        match: p.match,
        league: p.league,
        result: p.credited ? 'update' : 'dup',
        bytes: p.bytes,
        latency: at - p.sentAt,
        creditLatency: p.credited ? p.updateAt - p.sentAt : null,
        late: p.expired,
        so: p.so ?? null,
      };
    },

    // Отправки, на которые GC не ответил за grace. Это «не знаем», а не
    // «сожжён», поэтому в журнал они не идут.
    expire(now, graceMs) {
      const out = [];
      for (const p of pending) {
        if (p.answered) continue;
        if (!p.expired && now - p.sentAt > graceMs) {
          p.expired = true;
          out.push({ match: p.match, league: p.league, result: 'silent', bytes: 0, latency: null, creditLatency: null });
        }
        // Так поздно GC не отвечает — ответ потерян. Держать место дальше
        // значит сдвинуть следующие ответы.
        if (p.expired && now - p.sentAt > LOST_MS) p.answered = true;
      }
      prune();
      return out;
    },

    // Связь с GC оборвалась: всё безответное уже не получит ответа.
    // Ещё не объявленное тишиной возвращается, чтобы отчёт его увидел.
    lost() {
      const out = [];
      for (const p of pending) {
        if (p.answered) continue;
        if (!p.expired) out.push({ match: p.match, league: p.league, result: 'silent', bytes: 0, latency: null, creditLatency: null });
        p.answered = true;
      }
      prune();
      return out;
    },

    // Ждём ли ещё чего-то, на что стоит ждать: объявленное тишиной не в счёт.
    outstanding() {
      return pending.filter(p => open(p) && !p.expired).length;
    },
  };
}

// Разбор msg 26 (CMsgSOMultipleObjects), чтобы знать, ЧТО изменилось.
//
// Раньше любой msg 26 засчитывался самой старой отправке. Но он приходит
// не только от 7203: приезд вещи трейдом с закупки, вставка гема, действие
// из второй сессии — всё это тоже msg 26 и выглядело бы как «ОБНОВЛЕНО».
//
// Поля по gcsdk_gcmessages.proto:
//   2 objects_modified, 4 objects_added, 5 objects_removed — SingleObject
//   SingleObject: 1 type_id, 2 object_data;  type_id 1 = CSOEconItem
//
// Возвращает null, если сообщение не похоже на эту схему: тогда вызывающий
// ведёт себя по-старому. Живым прогоном схема ещё не сверена — поэтому
// строгий режим включается флагом (--strict-so), а по умолчанию разбор
// только пишется в отчёт.
function readVarint(buf, pos) {
  let v = 0n, shift = 0n;
  for (;;) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return { v, pos };
    shift += 7n;
    if (shift > 63n) return null;
  }
}

function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    if (!key) return null;
    pos = key.pos;
    const num = Number(key.v >> 3n), wire = Number(key.v & 7n);
    if (num <= 0) return null;
    if (wire === 0) {
      const r = readVarint(buf, pos); if (!r) return null;
      out.push({ num, wire, v: r.v }); pos = r.pos;
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return null;
      out.push({ num, wire }); pos += 8;
    } else if (wire === 2) {
      const len = readVarint(buf, pos); if (!len) return null;
      const end = len.pos + Number(len.v);
      if (end > buf.length) return null;
      out.push({ num, wire, data: buf.subarray(len.pos, end) }); pos = end;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) return null;
      out.push({ num, wire }); pos += 4;
    } else return null;
  }
  return out;
}

const ECON_ITEM = 1;

function soSummary(payload) {
  const top = fields(Buffer.from(payload || []));
  if (!top) return null;
  const s = { modified: 0, added: 0, removed: 0, econModified: 0, econAdded: 0, types: [] };
  let seen = false;
  for (const f of top) {
    const kind = f.num === 2 ? 'modified' : f.num === 4 ? 'added' : f.num === 5 ? 'removed' : null;
    if (!kind) continue;
    if (f.wire !== 2) return null;
    const inner = fields(f.data);
    if (!inner) return null;
    const t = inner.find(x => x.num === 1 && x.wire === 0);
    const type = t ? Number(t.v) : null;
    seen = true;
    s[kind]++;
    if (type !== null && !s.types.includes(type)) s.types.push(type);
    if (type === ECON_ITEM && kind === 'modified') s.econModified++;
    if (type === ECON_ITEM && kind === 'added') s.econAdded++;
  }
  return seen ? s : null;
}

// Засчитывать ли msg 26 отправке.
//
// Начисление меняет СУЩЕСТВУЮЩИЕ вещи — значит в сообщении должны быть
// изменённые CSOEconItem. Чистое добавление или удаление — это трейд или
// крафт, а не наш матч. Нераспознанное сообщение засчитывается по-старому:
// отказ по догадке стоил бы живого матча.
function creditsSend(summary, strict) {
  if (!strict || !summary) return true;
  return summary.econModified > 0;
}

const GC_STATUS_HAVE_SESSION = 0;

// CMsgConnectionStatus { status = 1 } — GC сообщает, что сессии больше нет.
function gcStatus(payload) {
  const f = fields(Buffer.from(payload || []));
  if (!f) return null;
  const s = f.find(x => x.num === 1 && x.wire === 0);
  return s ? Number(s.v) : GC_STATUS_HAVE_SESSION;
}

// Что делать с ошибкой Steam.
//
// Раньше обработчик убивал процесс на ЛЮБОЙ ошибке, хотя autoRelogin был
// включён — шанса ему не давали. На прогоне в два часа это значит, что
// одно обновление сессии десктопным Steam обрывает всю работу.
//
// «Выбило другой сессией» — не поломка. Steam допускает несколько входов,
// но клиент периодически подтверждает свою сессию и выбивает чужую. Кто
// оказался вторым — тот и вылетел. Правильная реакция: подождать и войти снова.
function classifyError(message) {
  const m = String(message || '');
  if (!m) return 'fatal';
  if (/InvalidPassword|AccessDenied|Expired|InvalidSignature/i.test(m)) return 'stale-token';
  if (/LoggedInElsewhere|LogonSessionReplaced|AlreadyLoggedInElsewhere/i.test(m)) return 'displaced';
  if (/RateLimit/i.test(m)) return 'rate-limit';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|NetworkFailure|ServiceUnavailable|TryAnotherCM/i.test(m)) return 'network';
  return 'fatal';
}

const isRecoverable = message =>
  ['displaced', 'rate-limit', 'network'].includes(classifyError(message));

// Пауза перед повторным входом. Растёт вдвое, потолок пять минут.
// Для лимита входов сразу пять: Steam ловит именно частые ВХОДЫ,
// и торопиться здесь дороже, чем подождать.
function retryDelay(attempt, kind) {
  const CAP = 300_000;
  if (kind === 'rate-limit') return CAP;
  return Math.min(CAP, 15_000 * Math.pow(2, Math.max(0, attempt)));
}

module.exports = {
  mergeLedger, effectiveDelay, validateRow, createTracker,
  classifyError, isRecoverable, retryDelay,
  soSummary, creditsSend, gcStatus, GC_STATUS_HAVE_SESSION, LOST_MS,
};
