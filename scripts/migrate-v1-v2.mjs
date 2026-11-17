#!/usr/bin/env node
/**
 * persona.db v1（骨架） → v2（阶段 2 目标 schema）幂等迁移。
 *
 * 只加列、不删列、不动数据；重复执行无副作用。
 * 默认 dry-run（只报告会加哪些列）；写库需要 --apply。
 *
 * 用法：
 *   node scripts/migrate-v1-v2.mjs --db=/path/persona.db            # dry-run
 *   node scripts/migrate-v1-v2.mjs --db=/path/persona.db --apply    # 真写
 *
 * 阶段 2 不执行生产迁移；生产库需统筹者显式 --force-prod。
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { guardProduction, parseArgs, resolveDbPath, stamp } from './_guard.mjs'
import { migrateToV2, SCHEMA_VERSION } from '../lib/db.js'

const args = parseArgs()
const dbPath = resolveDbPath(args)
guardProduction(dbPath, args)

const apply = args.apply === true
const saveBackup = args.backup !== false && apply

const db = new DatabaseSync(dbPath)
function readMeta(key) {
  try {
    return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null
  } catch {
    return null
  }
}
const before = readMeta('schema_version')
console.log(`库：${dbPath}`)
console.log(`schema_version（迁移前）：${before ?? '(无 meta 表，视为 v1)'}`)
console.log(`模式：${apply ? 'APPLY（会写库）' : 'DRY-RUN（不写库）'}`)

if (!apply) {
  const cols = (t) => {
    try {
      return db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name)
    } catch {
      return []
    }
  }
  const report = []
  const indexNeed = []
  const wantIndexes = {
    ux_self_single_active: 'self',
    ux_persona_versions_hash: 'persona_versions',
    ix_name_history_self: 'name_history',
    ix_emo_timeline: 'emotion_timeline',
    ix_emo_points: 'emotion_points',
    ix_emo_audit: 'emotion_audit',
  }
  const existingIndexes = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name),
  )
  for (const name of Object.keys(wantIndexes)) if (!existingIndexes.has(name)) indexNeed.push(name)
  const need = (table, col) => {
    if (cols(table).length && !cols(table).includes(col)) report.push(`${table}.${col}`)
  }
  need('self', 'name_version')
  need('name_history', 'source')
  need('persona_versions', 'content_hash')
  for (const c of ['confidence', 'source', 'certainty', 'label_updated_at']) need('emotion_state', c)
  for (const c of ['intensity', 'trigger', 'msg_ref']) need('emotion_timeline', c)
  for (const c of ['value_after', 'trigger', 'msg_ref']) need('emotion_points', c)
  for (const c of ['before_json', 'after_json']) need('emotion_audit', c)
  console.log(`待补列（${report.length}）：${report.join(', ') || '(无，已是 v2)'}`)
  console.log(`待建索引（${indexNeed.length}）：${indexNeed.join(', ') || '(无)'}`)
  console.log(`目标 schema_version=${SCHEMA_VERSION}`)
  db.close()
  process.exit(0)
}

if (saveBackup) {
  const dir = join(dirname(dbPath), 'backup')
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `persona.db.before-v2-${stamp()}`)
  copyFileSync(dbPath, dest)
  console.log(`已备份：${dest}`)
}

const result = migrateToV2(db)
console.log(`已补列（${result.added.length}）：${result.added.join(', ') || '(无)'}`)
const idx = result.indexes ?? { created: [], failed: [] }
console.log(`已建/确认索引（${idx.created.length}）：${idx.created.join(', ') || '(无)'}`)
if (idx.failed.length) {
  console.log(`⚠ 建不起来的索引（${idx.failed.length}）：`)
  for (const f of idx.failed) console.log(`  - ${f.name}: ${f.reason}`)
}
const after = readMeta('schema_version')
console.log(`schema_version（迁移后）：${after}`)
db.close()
