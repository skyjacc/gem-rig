// Пути к данным старой панели и ключам. Всё лежит в ../tools рядом с проектом.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(here, '..', '..')
export const TOOLS = path.join(ROOT, 'tools')
export const GC = path.join(TOOLS, 'gcwatch')
export const SNAPS = path.join(TOOLS, 'gemtrack-data')

export function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T } catch { return fallback }
}

function readKey(file: string, env: string) {
  const fromEnv = process.env[env]
  if (fromEnv?.trim()) return fromEnv.trim()
  try { return fs.readFileSync(path.join(TOOLS, file), 'utf8').trim() || null } catch { return null }
}

export const odKey = () => readKey('opendota.key', 'OPENDOTA_KEY')
export const steamKey = () => readKey('steam.key', 'STEAM_KEY')

export const STEAMID = process.env.STEAMID || '76561198362481819'
