import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { GC } from './paths.ts'
import { invOf } from './steam.ts'
import { paceFile, writePace, PACE_FLOOR } from './sender.ts'
import { slug } from './accounts.ts'

// Многоаккаунтность на уровне данных.
//
// До разбора инвентарь читался один на всю панель по константе STEAMID,
// а темп и отчёт лежали в общих файлах. Пока аккаунт был один, разницы
// не было; со вторым каждое такое место — потраченные впустую матчи:
// работник видел бы чужой состав, считал бы потолки по чужим счётчикам
// и разгонял бы чужой прогон. Отправка необратима, откатить нельзя.

const A = '76561190000000001'
const B = '76561190000000002'

test('снимок инвентаря у каждого аккаунта свой', () => {
  const a = invOf(A)
  const b = invOf(B)
  assert.notEqual(a, b, 'это должны быть разные объекты, а не один общий')
  assert.equal(a.steamid, A)
  assert.equal(b.steamid, B)
})

test('состав одного аккаунта не виден другому', () => {
  const a = invOf(A)
  a.rows = [{
    assetid: '1', name: 'Spectator: Alliance', gem: 'Alliance', hero: '',
    icon: '', value: 1200, carrier: 'gem', set: '', setPieces: [],
  }]
  a.ts = Date.now()

  const b = invOf(B)
  assert.equal(b.rows.length, 0, 'у второго аккаунта пусто, пока его не прочитали')
  assert.equal(b.ts, 0, 'и возраст снимка у него свой')
})

test('беда одного аккаунта не приписывается другому', () => {
  invOf(A).error = 'Steam 429'
  invOf(A).private = true
  assert.equal(invOf(B).error, null)
  assert.equal(invOf(B).private, false)
})

test('повторный вызов отдаёт тот же снимок, а не новый', () => {
  invOf(A).ts = 12345
  assert.equal(invOf(A).ts, 12345)
})

// ── темп ──

test('пауза пишется в файл своего аккаунта', () => {
  writePace('main', 1500)
  writePace('second', 4000)
  const read = (id: string) => fs.readFileSync(path.join(GC, paceFile(id)), 'utf8').trim()
  assert.equal(read('main'), '1500')
  assert.equal(read('second'), '4000', 'второй аккаунт не должен перетирать первый')
  assert.equal(read('main'), '1500', 'и первый не должен измениться от записи второго')
})

test('ниже предела отправщика пауза не уходит', () => {
  // Значение меньше пятисот отправщик из файла не принимает вовсе
  // (tools/gcwatch/lib.js, effectiveDelay) и молча остаётся на прежнем темпе:
  // панель показывала бы одно, а уходило бы другое.
  assert.equal(writePace('main', 100), PACE_FLOOR)
  assert.equal(fs.readFileSync(path.join(GC, paceFile('main')), 'utf8').trim(), String(PACE_FLOOR))
})

test('мусор вместо паузы не пишет мусор в файл', () => {
  assert.equal(writePace('main', NaN as any), PACE_FLOOR)
  assert.equal(writePace('main', -5), PACE_FLOOR)
})

// ── имена аккаунтов ──

test('метка превращается в безопасное имя файла', () => {
  assert.equal(slug('Основной'), 'acc', 'кириллица не годится для имени файла сессии')
  assert.equal(slug('Second Account'), 'second-account')
  assert.equal(slug('  ??? '), 'acc')
  assert.equal(slug(''), 'acc')
})

test('занятые имена не выдаются дважды', () => {
  assert.equal(slug('main', ['main']), 'main-2')
  assert.equal(slug('main', ['main', 'main-2']), 'main-3')
})

test('в имени не остаётся ничего, что уводит из папки', () => {
  for (const bad of ['../../etc', 'a/b', 'a\\b', '..']) {
    const s = slug(bad)
    assert.ok(!s.includes('..'), bad + ' -> ' + s)
    assert.ok(!s.includes('/'), bad + ' -> ' + s)
    assert.ok(!s.includes('\\'), bad + ' -> ' + s)
    assert.match(s, /^[a-z0-9-]+$/, bad + ' -> ' + s)
  }
})
