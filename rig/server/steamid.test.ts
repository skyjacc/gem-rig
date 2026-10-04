import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSteamid } from './paths.ts'

// steamid основного аккаунта — только снаружи репозитория: переменная
// STEAMID или файл tools/steamid. Здесь папка — временная, настоящая
// tools/ не читается. Все id вымышленные.

const A = '76561190000000007'
const B = '76561190000000008'

function withEnv(v: string | undefined, f: () => void) {
  const was = process.env.STEAMID
  if (v === undefined) delete process.env.STEAMID
  else process.env.STEAMID = v
  try { f() } finally { if (was === undefined) delete process.env.STEAMID; else process.env.STEAMID = was }
}

const dir = (content?: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gemtrack-steamid-'))
  if (content != null) fs.writeFileSync(path.join(d, 'steamid'), content)
  return d
}

test('переменная STEAMID — главнее файла', () => {
  withEnv(A, () => assert.equal(readSteamid(dir(B)), A))
})

test('без переменной — из файла tools/steamid (пробелы и перевод строки не мешают)', () => {
  withEnv(undefined, () => assert.equal(readSteamid(dir(' ' + B + '\n')), B))
})

test('ни переменной, ни файла — пусто, а не чей-то steamid', () => {
  withEnv(undefined, () => assert.equal(readSteamid(dir()), ''))
})

test('не 17 цифр — пусто; неверная переменная не уходит за файлом', () => {
  withEnv(undefined, () => assert.equal(readSteamid(dir('не steamid')), ''))
  withEnv('123', () => assert.equal(readSteamid(dir(B)), ''))
})
