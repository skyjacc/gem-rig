import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAlive } from './sender.ts'

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
