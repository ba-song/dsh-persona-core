#!/usr/bin/env node
/**
 * persona 备份（B5）：persona.db（VACUUM INTO 一致性快照）+ persona.md + manifest.sha256。
 * 只写备份目录，不碰生产文件。
 * 用法：node scripts/persona-backup.mjs [--data-dir /sdcard/DSHA/人格/数据] [--keep 20]
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const getArg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const dataDir = getArg('--data-dir', process.env.PERSONA_DATA_DIR || '/sdcard/DSHA/人格/数据')
const keep = Math.max(1, Number(getArg('--keep', 20)) || 20)
const dbPath = join(dataDir, 'persona.db')
const mdPath = join(dataDir, 'persona.md')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = join(dataDir, '备份', `persona-${stamp}`)

if (!existsSync(dbPath)) {
  console.error(`FAIL: 库不存在 ${dbPath}`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// 一致性快照：VACUUM INTO（源只读打开）
const snap = join(outDir, 'persona.db')
const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  db.exec(`VACUUM INTO '${snap.replaceAll("'", "''")}'`)
} finally {
  db.close()
}

let md = { copied: false, sha256: null, bytes: 0 }
if (existsSync(mdPath)) {
  copyFileSync(mdPath, join(outDir, 'persona.md'))
  md = { copied: true, sha256: sha256File(join(outDir, 'persona.md')), bytes: readFileSync(mdPath).length }
}

const manifest = {
  at: stamp,
  dataDir,
  db: { file: 'persona.db', sha256: sha256File(snap), bytes: readFileSync(snap).length },
  personaMd: md,
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

// 轮转：只清自己创建的 persona-* 目录，保留最近 keep 份
const backupsRoot = join(dataDir, '备份')
const dirs = readdirSync(backupsRoot)
  .filter((n) => n.startsWith('persona-') && /^\d{4}-\d{2}-\d{2}T/.test(n.slice('persona-'.length)))
  .sort()
while (dirs.length > keep) {
  const drop = dirs.shift()
  rmSync(join(backupsRoot, drop), { recursive: true, force: true })
}

console.log(JSON.stringify({ ok: true, outDir, dbBytes: manifest.db.bytes, mdBytes: md.bytes, kept: dirs.length }, null, 2))
