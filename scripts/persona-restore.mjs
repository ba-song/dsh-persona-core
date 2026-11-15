#!/usr/bin/env node
/**
 * persona 恢复（B5）：按备份目录恢复 persona.db + persona.md。
 * 默认只演练不落盘；加 --yes 才写。写之前先给当前文件做 .bak-<时间> 安全副本。
 * 用法：node scripts/persona-restore.mjs <备份目录> [--data-dir ...] [--yes]
 */
import { existsSync, copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const backupDir = args.find((a) => !a.startsWith('--'))
const dataDir = (() => {
  const i = args.indexOf('--data-dir')
  return i >= 0 && args[i + 1] ? args[i + 1] : process.env.PERSONA_DATA_DIR || '/sdcard/DSHA/人格/数据'
})()
const yes = args.includes('--yes')
if (!backupDir) {
  console.error('用法：node scripts/persona-restore.mjs <备份目录> [--data-dir ...] [--yes]')
  process.exit(1)
}
const manifestPath = join(backupDir, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error(`FAIL: 备份目录缺少 manifest.json：${backupDir}`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const srcDb = join(backupDir, 'persona.db')
if (!existsSync(srcDb)) {
  console.error('FAIL: 备份里没有 persona.db')
  process.exit(1)
}
if (sha256(srcDb) !== manifest.db.sha256) {
  console.error('FAIL: persona.db sha256 与 manifest 不一致，拒绝恢复')
  process.exit(1)
}
const srcMd = join(backupDir, 'persona.md')
const hasMd = existsSync(srcMd)

const plan = { dataDir, backupDir, db: true, personaMd: hasMd, write: yes }
if (!yes) {
  console.log(JSON.stringify({ ok: true, dryRun: true, ...plan }, null, 2))
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const dbPath = join(dataDir, 'persona.db')
const mdPath = join(dataDir, 'persona.md')
if (existsSync(dbPath)) copyFileSync(dbPath, `${dbPath}.bak-${stamp}`)
if (existsSync(mdPath)) copyFileSync(mdPath, `${mdPath}.bak-${stamp}`)
copyFileSync(srcDb, dbPath)
if (hasMd) copyFileSync(srcMd, mdPath)
console.log(JSON.stringify({ ok: true, restored: { db: dbPath, personaMd: hasMd ? mdPath : null }, safetyCopy: `.bak-${stamp}` }, null, 2))
