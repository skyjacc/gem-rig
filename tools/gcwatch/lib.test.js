const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeLedger, effectiveDelay } = require('./lib.js');

test('журнал сливается, а не затирается', () => {
  assert.deepEqual(mergeLedger(['1', '2', '3'], ['4']).sort(), ['1', '2', '3', '4']);
});

test('повторы не дублируются', () => {
  assert.deepEqual(mergeLedger(['1', '2'], ['2', '3']).sort(), ['1', '2', '3']);
});

test('пустая предыстория не мешает', () => {
  assert.deepEqual(mergeLedger([], ['1']), ['1']);
});

test('пустая добавка ничего не теряет', () => {
  assert.deepEqual(mergeLedger(['1', '2'], []).sort(), ['1', '2']);
});

test('порядок предыдущих записей сохраняется', () => {
  assert.deepEqual(mergeLedger(['b', 'a'], ['c']), ['b', 'a', 'c']);
});

test('явный --delay побеждает delay.txt', () => {
  assert.equal(effectiveDelay(true, 3000, 300000), 3000);
});

test('без флага работает delay.txt', () => {
  assert.equal(effectiveDelay(false, 2000, 300000), 300000);
});

test('без флага и без файла — значение по умолчанию', () => {
  assert.equal(effectiveDelay(false, 2000, null), 2000);
});

test('мусор в delay.txt игнорируется', () => {
  assert.equal(effectiveDelay(false, 2000, 10), 2000, 'меньше 500 мс не принимаем');
  assert.equal(effectiveDelay(false, 2000, NaN), 2000);
});

test('слишком малый --delay не проходит, откатываемся к файлу', () => {
  assert.equal(effectiveDelay(true, 100, 300000), 300000);
});

const { validateRow } = require('./lib.js');

test('строка без league_id не проходит проверку', () => {
  assert.match(validateRow({ match: '8003261364', league: '' }), /league_id/);
  assert.match(validateRow({ match: '8003261364' }), /league_id/);
});

test('полная строка проходит', () => {
  assert.equal(validateRow({ match: '8003261364', league: '16710' }), null);
});

test('строка без match_id не проходит', () => {
  assert.match(validateRow({ match: '', league: '16710' }), /match_id/);
  assert.match(validateRow({ match: 'abc', league: '16710' }), /match_id/);
});

const { createTracker } = require('./lib.js');

test('одна отправка, пришло обновление и ответ — update с задержками', () => {
  const t = createTracker();
  t.send('111', '9', 1000);
  t.onUpdate(1300, 507);
  const r = t.onResponse(1400);
  assert.equal(r.match, '111');
  assert.equal(r.result, 'update');
  assert.equal(r.bytes, 507);
  assert.equal(r.latency, 400, 'от отправки до 7204');
  assert.equal(r.creditLatency, 300, 'от отправки до msg 26');
});

test('ответ без обновления — dup', () => {
  const t = createTracker();
  t.send('222', '9', 1000);
  const r = t.onResponse(1100);
  assert.equal(r.result, 'dup');
  assert.equal(r.creditLatency, null);
});

test('опоздавший msg 26 достаётся своей отправке, а не следующей', () => {
  const t = createTracker();
  t.send('A', '9', 1000);
  t.send('B', '9', 2000);
  // обновление по A приходит уже ПОСЛЕ отправки B — раньше оно засчиталось бы B
  t.onUpdate(2100, 507);
  const a = t.onResponse(2200);
  const b = t.onResponse(3000);
  assert.equal(a.match, 'A');
  assert.equal(a.result, 'update', 'A получил своё обновление');
  assert.equal(b.match, 'B');
  assert.equal(b.result, 'dup', 'B не украл чужое');
});

test('порядок ответов соблюдается: первым разрешается первый отправленный', () => {
  const t = createTracker();
  t.send('A', '9', 1000);
  t.send('B', '9', 1010);
  t.send('C', '9', 1020);
  assert.equal(t.onResponse(1100).match, 'A');
  assert.equal(t.onResponse(1200).match, 'B');
  assert.equal(t.onResponse(1300).match, 'C');
});

test('ответ без единой отправки не роняет трекер', () => {
  const t = createTracker();
  assert.equal(t.onResponse(1000), null);
  t.onUpdate(1000, 100);
});

test('неотвеченные по истечении срока становятся silent', () => {
  const t = createTracker();
  t.send('X', '9', 1000);
  t.send('Y', '9', 5000);
  const dead = t.expire(12000, 10000);
  assert.equal(dead.length, 1, 'Y ещё в пределах срока');
  assert.equal(dead[0].match, 'X');
  assert.equal(dead[0].result, 'silent');
  assert.equal(dead[0].latency, null);
});

test('silent не выдаётся дважды', () => {
  const t = createTracker();
  t.send('X', '9', 1000);
  assert.equal(t.expire(12000, 10000).length, 1);
  assert.equal(t.expire(13000, 10000).length, 0);
});

test('счётчик неразрешённых показывает, сколько висит', () => {
  const t = createTracker();
  assert.equal(t.outstanding(), 0);
  t.send('A', '9', 1000);
  t.send('B', '9', 1010);
  assert.equal(t.outstanding(), 2);
  t.onResponse(1100);
  assert.equal(t.outstanding(), 1);
});

const { classifyError } = require('./lib.js');

test('протухший токен — фатально, надо переલогиниться заново', () => {
  for (const m of ['InvalidPassword', 'AccessDenied', 'Expired', 'InvalidSignature']) {
    assert.equal(classifyError(m), 'stale-token', m);
  }
});

test('выбило другой сессией — восстановимо, не повод падать', () => {
  for (const m of ['LoggedInElsewhere', 'LogonSessionReplaced', 'AlreadyLoggedInElsewhere']) {
    assert.equal(classifyError(m), 'displaced', m);
  }
});

test('лимит входов — ждём, а не падаем', () => {
  assert.equal(classifyError('RateLimitExceeded'), 'rate-limit');
});

test('сетевые обрывы восстановимы', () => {
  assert.equal(classifyError('ECONNRESET'), 'network');
  assert.equal(classifyError('ETIMEDOUT'), 'network');
  assert.equal(classifyError('NetworkFailure'), 'network');
});

test('незнакомое считаем фатальным — лучше остановиться, чем крутиться впустую', () => {
  assert.equal(classifyError('что-то новое'), 'fatal');
  assert.equal(classifyError(''), 'fatal');
  assert.equal(classifyError(undefined), 'fatal');
});

test('восстановимое отличается от фатального одним признаком', () => {
  const { isRecoverable } = require('./lib.js');
  assert.equal(isRecoverable('LoggedInElsewhere'), true);
  assert.equal(isRecoverable('RateLimitExceeded'), true);
  assert.equal(isRecoverable('ECONNRESET'), true);
  assert.equal(isRecoverable('InvalidPassword'), false);
  assert.equal(isRecoverable('что-то новое'), false);
});

test('пауза перед повтором растёт, но не бесконечно', () => {
  const { retryDelay } = require('./lib.js');
  assert.equal(retryDelay(0), 15_000);
  assert.equal(retryDelay(1), 30_000);
  assert.equal(retryDelay(2), 60_000);
  assert.equal(retryDelay(9), 300_000, 'потолок пять минут');
  assert.equal(retryDelay(99), 300_000);
});

test('лимит входов ждёт дольше обычного', () => {
  const { retryDelay } = require('./lib.js');
  assert.ok(retryDelay(0, 'rate-limit') >= 300_000, 'Steam ловит частые входы, спешить нельзя');
});

// ── сопоставление ответов ──

const { soSummary, creditsSend, gcStatus } = require('./lib.js');

test('опоздавший ответ достаётся своей отправке, а не следующей', () => {
  const t = createTracker();
  t.send('A', '1', 0);
  t.send('B', '1', 1000);
  // A молчит дольше grace — объявлена тишиной
  const dead = t.expire(16_000, 15_000);
  assert.deepEqual(dead.map(d => d.match), ['A']);
  // приходит опоздавший ответ A, потом ответ B
  const ra = t.onResponse(17_000);
  const rb = t.onResponse(17_100);
  assert.equal(ra.match, 'A');
  assert.equal(ra.late, true);
  assert.equal(rb.match, 'B');
  assert.equal(rb.late, false);
});

test('опоздавшее начисление уточняет тишину до update', () => {
  const t = createTracker();
  t.send('A', '1', 0);
  t.expire(16_000, 15_000);
  t.onUpdate(16_500, 97);
  const r = t.onResponse(16_600);
  assert.equal(r.result, 'update');
  assert.equal(r.late, true);
});

test('обрыв связи освобождает очередь — ответы после переподключения не сдвигаются', () => {
  const t = createTracker();
  t.send('A', '1', 0);
  t.send('B', '1', 100);
  const lost = t.lost();
  assert.deepEqual(lost.map(d => d.match), ['A', 'B']);
  t.send('C', '1', 5000);
  assert.equal(t.onResponse(5300).match, 'C');
});

test('ответ, не пришедший за LOST_MS, перестаёт держать место', () => {
  const t = createTracker();
  t.send('A', '1', 0);
  t.expire(16_000, 15_000);
  t.expire(121_000, 15_000);
  t.send('B', '1', 121_000);
  assert.equal(t.onResponse(121_300).match, 'B');
});

test('outstanding не ждёт объявленное тишиной', () => {
  const t = createTracker();
  t.send('A', '1', 0);
  assert.equal(t.outstanding(), 1);
  t.expire(16_000, 15_000);
  assert.equal(t.outstanding(), 0);
});

// ── разбор msg 26 ──

const vint = n => { const o = []; let v = BigInt(n); while (v >= 0x80n) { o.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; } o.push(Number(v)); return Buffer.from(o); };
const ld = (num, data) => Buffer.concat([vint((num << 3) | 2), vint(data.length), data]);
const single = type => Buffer.concat([vint(1 << 3), vint(type), ld(2, Buffer.from([1, 2, 3]))]);

test('msg 26 с изменённой вещью распознаётся', () => {
  const s = soSummary(Buffer.concat([ld(2, single(1)), ld(2, single(1))]));
  assert.equal(s.modified, 2);
  assert.equal(s.econModified, 2);
  assert.equal(creditsSend(s, true), true);
});

test('чистое добавление вещи (трейд) в строгом режиме не засчитывается', () => {
  const s = soSummary(ld(4, single(1)));
  assert.equal(s.econAdded, 1);
  assert.equal(creditsSend(s, true), false);
  assert.equal(creditsSend(s, false), true, 'без флага — по-старому');
});

test('нераспознанное сообщение засчитывается по-старому', () => {
  assert.equal(soSummary(Buffer.from([0xff])), null);
  assert.equal(creditsSend(null, true), true);
});

test('статус GC: сессия есть — 0, иначе номер', () => {
  assert.equal(gcStatus(Buffer.from([0x08, 0x00])), 0);
  assert.equal(gcStatus(Buffer.from([0x08, 0x02])), 2);
  assert.equal(gcStatus(Buffer.alloc(0)), 0);
});