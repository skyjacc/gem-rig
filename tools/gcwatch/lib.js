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
function createTracker() {
  const pending = [];

  const oldestOpen = () => pending.find(p => !p.done);

  return {
    send(match, league, at) {
      pending.push({ match, league, sentAt: at, credited: false, bytes: 0, updateAt: null, done: false });
    },

    // msg 26 — начисление произошло. Достаётся самой старой отправке,
    // которая ещё не получила своего обновления.
    onUpdate(at, bytes) {
      const p = pending.find(x => !x.done && !x.credited);
      if (!p) return;
      p.credited = true;
      p.bytes = bytes;
      p.updateAt = at;
    },

    // 7204 — GC отработал сообщение. Закрывает самую старую открытую отправку.
    onResponse(at) {
      const p = oldestOpen();
      if (!p) return null;
      p.done = true;
      return {
        match: p.match,
        league: p.league,
        result: p.credited ? 'update' : 'dup',
        bytes: p.bytes,
        latency: at - p.sentAt,
        creditLatency: p.credited ? p.updateAt - p.sentAt : null,
      };
    },

    // Отправки, на которые GC не ответил вовсе. Это «не знаем», а не «сожжён»,
    // поэтому в журнал они не идут.
    expire(now, graceMs) {
      const out = [];
      for (const p of pending) {
        if (p.done) continue;
        if (now - p.sentAt <= graceMs) continue;
        p.done = true;
        out.push({ match: p.match, league: p.league, result: 'silent', bytes: 0, latency: null, creditLatency: null });
      }
      return out;
    },

    outstanding() {
      return pending.filter(p => !p.done).length;
    },
  };
}

module.exports = { mergeLedger, effectiveDelay, validateRow, createTracker };
