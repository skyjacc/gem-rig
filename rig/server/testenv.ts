// Тестам — своя база.
//
// db.ts открывает базу прямо при импорте, и любой тест, который коснулся
// steam.ts или autopilot.ts, тянул за собой живой rig.db на 250 МБ: гонял
// по нему миграции и дрался за WAL-замок с работающей панелью. Тесты от
// этого падали через раз, и в отчёте это выглядело как поломка кода.
//
// Подключается флагом --import, то есть до первого импорта самих тестов.
process.env.RIG_DB ??= ':memory:'

// Вымышленный steamid основного аккаунта: настоящий tools/steamid тестам
// не нужен и читаться не должен.
process.env.STEAMID ??= '76561190000000001'

// И своя папка отправщика. В рабочей лежат очередь, темп и отчёт живого
// прогона: тест, который запишет туда паузу, поменяет темп настоящей работе —
// файл перечитывается перед каждой отправкой.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (!process.env.GC_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemtrack-gc-'))
  process.env.GC_DIR = dir
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { } })
}

// И свой реестр аккаунтов. tools/accounts.json — рабочий: тест, который
// привяжет или отвяжет аккаунт, поменял бы список живой панели.
process.env.ACCOUNTS_FILE ??= path.join(process.env.GC_DIR!, 'accounts.json')
