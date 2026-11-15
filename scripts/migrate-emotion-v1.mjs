#!/usr/bin/env node
/**
 * 情绪迁移：memory.db（session_key='global'）→ persona.db v2（self_id）。
 *
 * - 默认 dry-run：只报告行数、映射、会被丢弃的字段，不写库
 * - `--apply` 才写；写库前自动备份 persona.db；一个事务内完成
 * - `--rollback`：按 meta.emo_migrate 记录精确删除本次插入的行并恢复原状态行
 * - 幂等：重复 apply 不会重复插入（按自然键去重）
 *
 * 用法：
 *   node scripts/migrate-emotion-v1.mjs --db=/tmp/persona.db --memory-db=/tmp/memory.db
 *   node scripts/migrate-emotion-v1.mjs --db=/tmp/persona.db --memory-db=/tmp/memory.db --apply
 *   node scripts/migrate-emotion-v1.mjs --db=/tmp/persona.db --rollback
 *
 * 阶段 3 只允许在临时库演练；生产 persona.db 需统筹者显式 --force-prod。
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { guardProduction, parseArgs, resolveDbPath, stamp } from './_guard.mjs'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { masked } from '../lib/emotion.js'

const args = parseArgs()
// 目标 persona.db 允许不存在（阶段 3 演习就是从空库开始建）；生产路径仍由 guardProduction 拦
if (args.allowMissing === undefined) args.allowMissing = true
const dbPath = resolveDbPath(args)
guardProduction(dbPath, args)

const KEY = String(args.key ?? 'global')
const triggerMax = Number(args['trigger-max-chars'] ?? 60)
const seedName = String(args['seed-name'] ?? '汐')
const apply = args.apply === true
const rollback = args.rollback === true
const META_KEY = 'emo_migrate'

function readMetaSafe(db, key) {
  try {
    return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value
  } catch {
    return undefined
  }
}

function writeMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value))
}

// ── 回滚 ────────────────────────────────────────────────────────────────
if (rollback) {
  const db = openDb(dbPath)
  const raw = readMetaSafe(db, META_KEY)
  if (!raw) {
    console.log('没有迁移记录（meta.emo_migrate 不存在），无需回滚')
    db.close()
    process.exit(0)
  }
  const rec = JSON.parse(raw)
  const ids = rec.inserted ?? {}
  const plan = {
    timeline: (ids.timeline ?? []).length,
    points: (ids.points ?? []).length,
    audit: (ids.audit ?? []).length,
    state: rec.state?.replaced ? 'restore' : 'delete',
  }
  console.log(`回滚目标：${dbPath}`)
  console.log(`批次：${rec.batch}（${new Date(rec.at).toISOString()}）self_id=${rec.selfId}`)
  console.log(`将删除：timeline ${plan.timeline} / points ${plan.points} / audit ${plan.audit}；状态行：${plan.state}`)
  if (!apply) {
    console.log('DRY-RUN：加 --apply 才执行回滚')
    db.close()
    process.exit(0)
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const t of ['timeline', 'points', 'audit']) {
      const stmt = db.prepare(`DELETE FROM emotion_${t} WHERE id=?`)
      for (const id of ids[t] ?? []) stmt.run(id)
    }
    if (rec.state?.replaced) {
      const prev = rec.state.prev
      db.prepare(
        `INSERT INTO emotion_state(self_id,valence,arousal,certainty,label,intensity,confidence,source,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(self_id) DO UPDATE SET valence=excluded.valence, arousal=excluded.arousal,
           certainty=excluded.certainty, label=excluded.label, intensity=excluded.intensity,
           confidence=excluded.confidence, source=excluded.source, updated_at=excluded.updated_at`,
      ).run(prev.self_id, prev.valence, prev.arousal, prev.certainty, prev.label, prev.intensity, prev.confidence, prev.source, prev.updated_at)
    } else if (rec.state?.inserted) {
      db.prepare('DELETE FROM emotion_state WHERE self_id=?').run(rec.selfId)
    }
    db.prepare('DELETE FROM meta WHERE key=?').run(META_KEY)
    db.exec('COMMIT')
    console.log(`回滚完成：删除 ${plan.timeline + plan.points + plan.audit} 行，状态行已${plan.state === 'restore' ? '恢复' : '清除'}`)
  } catch (error) {
    db.exec('ROLLBACK')
    console.error(`回滚失败：${error.message}`)
    process.exit(5)
  }
  db.close()
  process.exit(0)
}

// ── 迁移 ────────────────────────────────────────────────────────────────
if (!args['memory-db']) {
  console.error('缺少 --memory-db=<memory.db 副本路径>')
  process.exit(2)
}
const memoryPath = resolve(String(args['memory-db']))
// 线上 memory.db 路径（新机器 + 旧机器遗留）先拦再查存在：不存在的生产路径也要给出「拒绝」而不是「不存在」
const LIVE_MEMORY_PATHS = [
  '/sdcard/DSHA/记忆/数据/memory.db',
  '/opt/qqai/dy-memory/memory.db',
  '/sdcard/Documents/DSH记忆档案/memory-core-live/memory.db',
]
if (LIVE_MEMORY_PATHS.some((p) => resolve(p) === memoryPath) && args['force-prod-source'] !== true) {
  console.error(`拒绝直接读线上 memory.db：${memoryPath}\n先复制一份副本再迁移（确认要直读加 --force-prod-source）`)
  process.exit(3)
}
if (!existsSync(memoryPath)) {
  console.error(`memory 库不存在：${memoryPath}`)
  process.exit(2)
}

const src = new DatabaseSync(memoryPath, { readOnly: true })
const counts = (db) => ({
  state: db.prepare('SELECT COUNT(*) c FROM emotion_state WHERE session_key=?').get(KEY).c,
  timeline: db.prepare('SELECT COUNT(*) c FROM emotion_timeline WHERE session_key=?').get(KEY).c,
  points: db.prepare('SELECT COUNT(*) c FROM emotion_points WHERE session_key=?').get(KEY).c,
  audit: db.prepare('SELECT COUNT(*) c FROM emotion_audit WHERE session_key=?').get(KEY).c,
})
const srcCounts = counts(src)
const otherKeys = src
  .prepare("SELECT session_key, COUNT(*) c FROM emotion_timeline WHERE session_key<>? GROUP BY session_key")
  .all(KEY)

console.log(`persona 库：${dbPath}`)
console.log(`memory 源：${memoryPath}（只读）`)
console.log(`键：${KEY} → 目标 self_id`)
console.log(`模式：${apply ? 'APPLY（会写 persona.db）' : 'DRY-RUN（不写库）'}`)
console.log(`源行数：state ${srcCounts.state} / timeline ${srcCounts.timeline} / points ${srcCounts.points} / audit ${srcCounts.audit}`)
if (otherKeys.length) console.log(`⚠ 其他 session_key（本次不迁移）：${otherKeys.map((r) => `${r.session_key}×${r.c}`).join(', ')}`)

const dbExists = existsSync(dbPath)

if (!apply) {
  // dry-run：绝不在目标库上写任何东西；库不存在就只报计划
  if (dbExists) {
    const ro = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const selfRow = ro.prepare("SELECT * FROM self WHERE status='active' LIMIT 1").get()
      const cnt = (t) => {
        try {
          return ro.prepare(`SELECT COUNT(*) c FROM emotion_${t} WHERE self_id=?`).get(selfRow?.id ?? '').c
        } catch {
          return 0
        }
      }
      console.log(`目标行数（迁移前）：state ${cnt('state')} / timeline ${cnt('timeline')} / points ${cnt('points')} / audit ${cnt('audit')}`)
      console.log(`self_id：${selfRow?.id ?? '(无 active self 行，apply 时新建)'}`)
      const prevRec = readMetaSafe(ro, META_KEY)
      if (prevRec) console.log('⚠ 目标库已有迁移记录：重复 apply 会按自然键去重，不会重复插入')
    } catch (error) {
      console.log(`目标库存在但读不了：${error.message}`)
    } finally {
      ro.close()
    }
  } else {
    console.log('目标行数（迁移前）：目标库不存在')
    console.log('self_id：apply 时新建（schema v2 + 生成 self:uuid）')
  }
  console.log('')
  console.log('字段映射与丢失：')
  console.log('  state.session_key            → self_id                    (映射)')
  console.log('  state.certainty              → 0.5 默认                   (源表无此语义，丢失)')
  console.log('  state.confidence/source      → 原样保留')
  console.log('  timeline.msg_ref             → "" 空串                    (源表没有，丢失：无法回查具体消息)')
  console.log(`  timeline.trigger             → 打码 + 截断 ${triggerMax} 字        (可能被截断)`)
  console.log('  points.reason / source_seq   → 不迁移                     (目标 v2 无这两列)')
  console.log('  audit.payload                → before_json                (保留；action=原 source)')
  console.log('  audit.after_json             → NULL                       (源表无)')
  console.log('')
  console.log('DRY-RUN：以上为计划；加 --apply 才会写库（写前自动备份）')
  src.close()
  process.exit(0)
}

const personaDb = openDb(dbPath)
const self = ensureSelf(personaDb, seedName, args['self-id'] ? String(args['self-id']) : null)
const target = {
  state: personaDb.prepare('SELECT COUNT(*) c FROM emotion_state WHERE self_id=?').get(self.id).c,
  timeline: personaDb.prepare('SELECT COUNT(*) c FROM emotion_timeline WHERE self_id=?').get(self.id).c,
  points: personaDb.prepare('SELECT COUNT(*) c FROM emotion_points WHERE self_id=?').get(self.id).c,
  audit: personaDb.prepare('SELECT COUNT(*) c FROM emotion_audit WHERE self_id=?').get(self.id).c,
}
console.log(`目标行数（迁移前）：state ${target.state} / timeline ${target.timeline} / points ${target.points} / audit ${target.audit}`)
console.log(`self_id：${self.id}（display_name=${self.display_name}）`)
console.log('')
if (!apply) {
  console.log('')
  console.log('DRY-RUN：以上为计划；加 --apply 才会写库（写前自动备份）')
  src.close()
  personaDb.close()
  process.exit(0)
}

// 备份
const backupDir = join(dirname(dbPath), 'backup')
mkdirSync(backupDir, { recursive: true })
const backupPath = join(backupDir, `persona.db.before-emo-migrate-${stamp()}`)
if (dbExists) {
  copyFileSync(dbPath, backupPath)
  console.log('')
  console.log(`已备份：${backupPath}`)
}

const prevRec = (() => {
  try {
    const raw = readMetaSafe(personaDb, META_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
})()

const rec = {
  batch: `emo-${stamp()}`,
  at: Date.now(),
  selfId: self.id,
  source: { path: memoryPath, key: KEY, counts: srcCounts },
  inserted: { timeline: [], points: [], audit: [] },
  state: { replaced: false, inserted: false, prev: null },
}
const addedNow = { timeline: 0, points: 0, audit: 0 }
let stateNow = '未改'

const round6 = (x) => Math.round(Number(x ?? 0) * 1e6) / 1e6

personaDb.exec('BEGIN IMMEDIATE')
try {
  // 1) 状态行
  const st = src.prepare('SELECT * FROM emotion_state WHERE session_key=?').get(KEY)
  if (st) {
    const existing = personaDb.prepare('SELECT * FROM emotion_state WHERE self_id=?').get(self.id)
    const same = existing && Number(existing.updated_at) === Number(st.updated_at) && Number(existing.valence) === Number(st.valence)
    if (!same) {
      if (existing) {
        rec.state.replaced = true
        rec.state.prev = { ...existing }
        stateNow = '覆盖'
      } else {
        rec.state.inserted = true
        stateNow = '新建'
      }
      personaDb
        .prepare(
          `INSERT INTO emotion_state(self_id,valence,arousal,certainty,label,intensity,confidence,source,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(self_id) DO UPDATE SET valence=excluded.valence, arousal=excluded.arousal,
             certainty=excluded.certainty, label=excluded.label, intensity=excluded.intensity,
             confidence=excluded.confidence, source=excluded.source, updated_at=excluded.updated_at`,
        )
        .run(self.id, st.valence, st.arousal, 0.5, st.label, st.intensity, st.confidence ?? 0, st.source ?? 'rule', st.updated_at)
    }
  }

  // 2) 时间线
  const hasTl = (r) =>
    personaDb
      .prepare(
        `SELECT id FROM emotion_timeline WHERE self_id=? AND at=? AND label=? AND ROUND(valence,6)=ROUND(?,6) AND ROUND(arousal,6)=ROUND(?,6) LIMIT 1`,
      )
      .get(self.id, r.at, r.label, round6(r.valence), round6(r.arousal))
  for (const r of src.prepare('SELECT * FROM emotion_timeline WHERE session_key=? ORDER BY at').all(KEY)) {
    if (hasTl(r)) continue
    const info = personaDb
      .prepare('INSERT INTO emotion_timeline(self_id,at,valence,arousal,label,intensity,trigger,msg_ref) VALUES(?,?,?,?,?,?,?,?)')
      .run(self.id, r.at, r.valence, r.arousal, r.label, r.intensity ?? 0, masked(r.trigger, triggerMax), '')
    rec.inserted.timeline.push(Number(info.lastInsertRowid))
    addedNow.timeline += 1
  }

  // 3) 转折点
  const hasPt = (r) =>
    personaDb
      .prepare('SELECT id FROM emotion_points WHERE self_id=? AND at=? AND dimension=? AND ROUND(delta,6)=ROUND(?,6) LIMIT 1')
      .get(self.id, r.at, r.dimension, round6(r.delta))
  for (const r of src.prepare('SELECT * FROM emotion_points WHERE session_key=? ORDER BY at').all(KEY)) {
    if (hasPt(r)) continue
    const info = personaDb
      .prepare('INSERT INTO emotion_points(self_id,at,dimension,delta,value_after,trigger,msg_ref) VALUES(?,?,?,?,?,?,?)')
      .run(self.id, r.at, r.dimension, r.delta, r.value_after ?? 0, masked(r.trigger, triggerMax), String(r.msg_ref ?? ''))
    rec.inserted.points.push(Number(info.lastInsertRowid))
    addedNow.points += 1
  }

  // 4) 审计
  const hasAudit = (r) =>
    personaDb
      .prepare("SELECT id FROM emotion_audit WHERE self_id=? AND at=? AND action=? AND COALESCE(before_json,'')=COALESCE(?, '') LIMIT 1")
      .get(self.id, r.at, r.source ?? 'rule', r.payload ?? null)
  for (const r of src.prepare('SELECT * FROM emotion_audit WHERE session_key=? ORDER BY at').all(KEY)) {
    if (hasAudit(r)) continue
    const info = personaDb
      .prepare("INSERT INTO emotion_audit(at,self_id,action,before_json,after_json,note) VALUES(?,?,?,?,NULL,'from memory.db')")
      .run(r.at, self.id, r.source ?? 'rule', r.payload ?? null)
    rec.inserted.audit.push(Number(info.lastInsertRowid))
    addedNow.audit += 1
  }

  // 累积：同一库多次 apply（例如分两批）也能一次回滚全部
  if (prevRec) {
    for (const t of ['timeline', 'points', 'audit']) {
      rec.inserted[t] = [...new Set([...(prevRec.inserted?.[t] ?? []), ...rec.inserted[t]])]
    }
    if (!rec.state.replaced && !rec.state.inserted && prevRec.state) rec.state = prevRec.state
    if (prevRec.batch) rec.batch = prevRec.batch
  }
  writeMeta(personaDb, META_KEY, JSON.stringify(rec))
  personaDb.exec('COMMIT')
} catch (error) {
  personaDb.exec('ROLLBACK')
  console.error(`迁移失败：${error.message}`)
  src.close()
  personaDb.close()
  process.exit(5)
}

const after = {
  state: personaDb.prepare('SELECT COUNT(*) c FROM emotion_state WHERE self_id=?').get(self.id).c,
  timeline: personaDb.prepare('SELECT COUNT(*) c FROM emotion_timeline WHERE self_id=?').get(self.id).c,
  points: personaDb.prepare('SELECT COUNT(*) c FROM emotion_points WHERE self_id=?').get(self.id).c,
  audit: personaDb.prepare('SELECT COUNT(*) c FROM emotion_audit WHERE self_id=?').get(self.id).c,
}
console.log('')
console.log(`本次新增：timeline ${addedNow.timeline} / points ${addedNow.points} / audit ${addedNow.audit}；状态行 ${stateNow}`)
console.log(`回滚记录累计：timeline ${rec.inserted.timeline.length} / points ${rec.inserted.points.length} / audit ${rec.inserted.audit.length}`)
console.log(`目标行数（迁移后）：state ${after.state} / timeline ${after.timeline} / points ${after.points} / audit ${after.audit}`)
console.log(`批次：${rec.batch}（回滚：--rollback）`)
src.close()
personaDb.close()
