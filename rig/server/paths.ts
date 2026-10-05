// Пути к данным старой панели и ключам. Всё лежит в ../tools рядом с проектом.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(here, '..', '..')
export const TOOLS = path.join(ROOT, 'tools')

// Папка отправщика — или та, что назвали в GC_DIR.
//
// Сюда пишутся очередь, темп и отчёт живого отправщика. Тест, который
// тронет её по-настоящему, поменяет темп работающему прогону: файл
// перечитывается перед каждой отправкой. Подмена нужна ровно для того,
// чтобы проверять эти записи, ничего при этом не задев.
export const GC = process.env.GC_DIR || path.join(TOOLS, 'gcwatch')
export const SNAPS = path.join(TOOLS, 'gemtrack-data')

export function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T } catch { return fallback }
}

function readKey(file: string, env: string, dir = TOOLS) {
  const fromEnv = process.env[env]
  if (fromEnv?.trim()) return fromEnv.trim()
  try { return fs.readFileSync(path.join(dir, file), 'utf8').trim() || null } catch { return null }
}

export const odKey = () => readKey('opendota.key', 'OPENDOTA_KEY')
export const steamKey = () => readKey('steam.key', 'STEAM_KEY')
// Ключ площадки market.dota2.net. Им списываются деньги, поэтому лежит
// рядом с остальными ключами и в репозиторий не попадает.
export const marketKey = () => readKey('market.key', 'MARKET_KEY')

// steamid основного аккаунта — только снаружи репозитория (он публичный):
// переменная STEAMID или файл tools/steamid (закрыт .gitignore). Нужен один
// раз — завести первый аккаунт, когда реестра ещё нет. Не 17 цифр — нет:
// чужой или выдуманный steamid хуже пустого, первый аккаунт тогда
// привязывается по QR. Неверная переменная за файлом не уходит.
export function readSteamid(dir = TOOLS): string {
  const v = readKey('steamid', 'STEAMID', dir) ?? ''
  return /^\d{17}$/.test(v) ? v : ''
}

export const STEAMID = readSteamid()

// Внешний адрес панели (план 7, §12.5): нужен входу через Steam — адрес
// возврата и realm. Только из окружения, никогда из заголовка Host. Нет —
// вход через Steam выключен.
export const PANEL_URL = String(process.env.PANEL_URL ?? '').trim().replace(/\/+$/, '')
