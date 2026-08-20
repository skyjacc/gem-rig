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

module.exports = { mergeLedger, effectiveDelay };
