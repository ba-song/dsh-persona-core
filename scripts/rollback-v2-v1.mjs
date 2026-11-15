#!/usr/bin/env node
/**
 * v2 → v1 回滚（只处理 schema 加列，不动业务数据）。
 *
 * 两种模式：
 *   --mode=copy（默认）：把 v2 库导出成一份 v1 结构的新库，原库不动（最安全）
 *   --mode=drop       ：在目标库上删除 v2 新增列（需要 SQLite ≥ 3.35）
 *
 * 默认 dry-run；写操作需要 --apply。
 * 阶段 2 不执行生产回滚；生产库需 --force-prod。
 *
 * 用法：
 *   node scripts/rollback-v2-v1.mjs --db=/path/persona.db --out=/path/persona-v1.db
 *   node scripts/rollback-v2-v1.mjs --db=/path/persona.db --mode=drop --apply
 */
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { guardProduction, parseArgs, resolveDbPath, stamp } from './_guard.mjs'

const args = parseArgs()
const dbPath = resolveDbPath(args)
guardProduction(dbPath, args)
const mode = String(args.mode ?? 'copy')
const apply = args.apply === true

function trackedAdded() {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='v2_added'").get()
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed?.columns)) return null
    return parsed
  } catch {
    return null
  }
}

const V2_INDEXES = [
  'ux_self_single_active',
  'ux_persona_versions_hash',
  'ix_name_history_self',
  'ix_emo_timeline',
  'ix_emo_points',
  'ix_emo_audit',
]

function staticPairs() {
  return Object.entries(V2_ADDED).flatMap(([table, cols]) => cols.map((col) => `${table}.${col}`))
}

const V2_ADDED = {
  self: ['name_version'],
  name_history: ['source'],
  persona_versions: ['content_hash'],
  emotion_state: ['confidence', 'source', 'certainty'],
  emotion_timeline: ['intensity', 'trigger', 'msg_ref'],
  emotion_points: ['value_after', 'trigger', 'msg_ref'],
  emotion_audit: ['before_json', 'after_json'],
}

const db = new DatabaseSync(dbPath)
function readMeta(key) {
  try {
    return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null
  } catch {
    return null
  }
}
const version = readMeta('schema_version') ?? '1'
const tracked = trackedAdded()
const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get()?.v ?? ''
console.log(`库：${dbPath}`)
console.log(`schema_version=${version}  sqlite=${sqliteVersion}  mode=${mode}  ${apply ? 'APPLY' : 'DRY-RUN'}`)

if (mode === 'drop') {
  const supportsDrop = String(sqliteVersion).localeCompare('3.35.0', undefined, { numeric: true }) >= 0
  if (!supportsDrop) {
    console.error(`SQLite ${sqliteVersion} 不支持 DROP COLUMN，请改用 --mode=copy`)
    process.exit(4)
  }
  const plan = []
  for (const item of tracked?.columns?.length ? tracked.columns : staticPairs()) {
    const [table, col] = String(item).split('.')
    let existing = []
    try {
      existing = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
    } catch {}
    if (existing.includes(col)) plan.push(`${table}.${col}`)
  }
  console.log(`将删除列（${plan.length}）：${plan.join(', ') || '(无)'}`)
  if (!apply) process.exit(0)
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const name of tracked?.indexes?.length ? tracked.indexes : V2_INDEXES) db.exec(`DROP INDEX IF EXISTS ${name}`)
    for (const item of plan) {
      const [table, col] = item.split('.')
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`)
    }
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
    db.exec('COMMIT')
    console.log('回滚完成（schema_version=1）')
  } catch (error) {
    db.exec('ROLLBACK')
    console.error(`回滚失败：${error.message}`)
    process.exit(5)
  }
  db.close()
  process.exit(0)
}

// copy 模式：导出 v1 结构的新库，原库只读
const out = String(args.out ?? join(dirname(dbPath), `persona-v1-${stamp()}.db`))
console.log(`将导出 v1 结构到：${out}`)
if (!apply) {
  console.log('DRY-RUN：加 --apply 才会写文件')
  process.exit(0)
}
if (existsSync(out) && args.overwrite !== true) {
  console.error(`目标已存在：${out}（要覆盖加 --overwrite）`)
  process.exit(6)
}
mkdirSync(dirname(out), { recursive: true })
copyFileSync(dbPath, out)
const v1 = new DatabaseSync(out)
v1.exec('BEGIN IMMEDIATE')
try {
  for (const name of tracked?.indexes?.length ? tracked.indexes : V2_INDEXES) v1.exec(`DROP INDEX IF EXISTS ${name}`)
  for (const item of tracked?.columns?.length ? tracked.columns : staticPairs()) {
    const [table, col] = String(item).split('.')
    let existing = []
    try {
      existing = v1.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
    } catch {
      continue
    }
    if (existing.includes(col)) v1.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`)
  }
  v1.prepare("INSERT INTO meta(key,value) VALUES('schema_version','1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
  v1.exec('COMMIT')
  console.log('导出完成（原库未改动）')
} catch (error) {
  v1.exec('ROLLBACK')
  console.error(`导出失败：${error.message}`)
  process.exit(7)
}
v1.close()