import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAlive, paceFile, queueFile, safeName, statusFile } from './sender.ts'

// 21 августа панель двадцать минут считала отправщик живым, хотя процесса
// уже не было. Проверка была `exitCode === null`, а процесс, убитый
// сигналом, оставляет exitCode пустым навсегда и ставит signalCode.
//
// Последствие тяжелее самой ошибки: работник видел «жив», ничего не делал,
// и следующий запуск не происходил вовсе. Ни одной отправки, при этом
// в панели всё выглядело работающим.

test('процесс без потомка мёртв', () => {
  assert.equal(isAlive(null), false)
})

test('живой процесс: ни кода, ни сигнала', () => {
  assert.equal(isAlive({ exitCode: null, signalCode: null }), true)
})

test('вышел сам с кодом — мёртв', () => {
  assert.equal(isAlive({ exitCode: 0, signalCode: null }), false)
  assert.equal(isAlive({ exitCode: 1, signalCode: null }), false)
})

test('убит сигналом — мёртв, хотя код пустой', () => {
  assert.equal(isAlive({ exitCode: null, signalCode: 'SIGTERM' }), false)
})

test('убит жёстко — тоже мёртв', () => {
  assert.equal(isAlive({ exitCode: null, signalCode: 'SIGKILL' }), false)
})

// ── имя файла очереди ──
//
// Имя приходило снаружи и склеивалось с папкой отправщика без проверки,
// а за этой кнопкой — процесс, который шлёт необратимые сообщения GC.
// Сама кнопка убрана, но проверка осталась: она защищает и остальные пути.

test('обычное имя очереди принимается', () => {
  assert.equal(safeName('autopilot.csv'), true)
  assert.equal(safeName('autopilot-second.csv'), true)
  assert.equal(safeName('build-team_liquid.csv'), true)
})

test('выход за папку отправщика отбивается', () => {
  assert.equal(safeName('../../../etc/passwd'), false)
  assert.equal(safeName('../autopilot.csv'), false)
  assert.equal(safeName('a/../../b.csv'), false)
  assert.equal(safeName('C:\Windows\win.ini'), false)
})

test('не csv — не очередь', () => {
  assert.equal(safeName('token.json'), false)
  assert.equal(safeName('autopilot'), false)
  assert.equal(safeName(''), false)
})

// ── файлы по аккаунту ──
//
// Общий delay.txt был ошибкой того же рода, что общий status.json: два
// работника с разными сроками перетирали друг другу темп, и тот, кто тикнул
// последним, задавал скорость обоим.

test('у каждого аккаунта свои файлы, у первого — прежние имена', () => {
  assert.equal(paceFile('main'), 'delay.txt')
  assert.equal(statusFile('main'), 'status.json')
  assert.equal(queueFile('main'), 'autopilot.csv')

  assert.equal(paceFile('second'), 'delay-second.txt')
  assert.equal(statusFile('second'), 'status-second.json')
  assert.equal(queueFile('second'), 'autopilot-second.csv')
})

test('файлы двух аккаунтов не совпадают ни в чём', () => {
  const a = [paceFile('one'), statusFile('one'), queueFile('one')]
  const b = [paceFile('two'), statusFile('two'), queueFile('two')]
  assert.equal(a.some(x => b.includes(x)), false)
})
