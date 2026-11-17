/** 情绪迁移脚本：临时库上的映射/去重/幂等/回滚（不碰生产）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join as pjoin } from 'node:path'
import { tmpDir } from './helpers/fixtures.mjs'

const SCRIPT = new URL('../scripts/migrate-emotion-v1.mjs', import.meta.url).pathname

/** 造一个 memory.db 形状（只含 emotion 四表 + 必要的列）。 */
function makeMemoryDb(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE emotion_state (
      session_key TEXT PRIMARY KEY, valence REAL NOT NULL DEFAULT 0, arousal REAL NOT NULL DEFAULT 0.2,
      label TEXT NOT NULL DEFAULT '平静', intensity REAL NOT NULL DEFAULT 0.2,
      confidence REAL NOT NULL DEFAULT 0.5, source TEXT NOT NULL DEFAULT 'rule', updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE emotion_timeline (
      id INTEGER PRIMARY KEY, session_key TEXT NOT NULL, valence REAL NOT NULL, arousal REAL NOT NULL,
      label TEXT NOT NULL, intensity REAL NOT NULL, trigger TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL
    );
    CREATE TABLE emotion_points (
      id INTEGER PRIMARY KEY, session_key TEXT NOT NULL, dimension TEXT NOT NULL, at INTEGER NOT NULL,
      delta REAL NOT NULL, value_after REAL NOT NULL, trigger TEXT NOT NULL DEFAULT '', msg_ref TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE emotion_audit (
      id INTEGER PRIMARY KEY, session_key TEXT NOT NULL, source TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', at INTEGER NOT NULL
    );
  `)
  const at = 1793000000000
  db.prepare("INSERT INTO emotion_state(session_key,valence,arousal,label,intensity,confidence,source,updated_at) VALUES('global',0.31,0.44,'开心',0.44,0.63,'rule',?)").run(at)
  // 两条时间线：一条正常，一条含手机号（验证打码）
  db.prepare("INSERT INTO emotion_timeline(id,session_key,valence,arousal,label,intensity,trigger,at) VALUES(1,'global',0.3,0.4,'开心',0.4,'今天顺',?)").run(at)
  db.prepare("INSERT INTO emotion_timeline(id,session_key,valence,arousal,label,intensity,trigger,at) VALUES(2,'global',0.5,0.6,'兴奋',0.6,'联系 13800138000 说好了',?)").run(at + 1)
  db.prepare("INSERT INTO emotion_points(id,session_key,dimension,at,delta,value_after,trigger,msg_ref) VALUES(1,'global','arousal',? ,0.1537,0.44,'今天顺','explicit:sess-1:51')").run(at)
  db.prepare("INSERT INTO emotion_audit(id,session_key,source,payload,at) VALUES(1,'global','rule','{\"hits\":2}',?)").run(at)
  db.prepare("INSERT INTO emotion_audit(id,session_key,source,payload,at) VALUES(2,'global','rule-none','{\"hits\":0}',?)").run(at + 2)
  // 其他会话键：应被跳过并提示
  db.prepare("INSERT INTO emotion_timeline(id,session_key,valence,arousal,label,intensity,trigger,at) VALUES(3,'qq:other',0,0.2,'平静',0.2,'',?)").run(at)
  db.close()
}

function run(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
}

function counts(personaPath) {
  const db = new DatabaseSync(personaPath, { readOnly: true })
  const self = db.prepare("SELECT * FROM self WHERE status='active'").get()
  const out = { selfId: self?.id, displayName: self?.display_name }
  for (const t of ['emotion_state', 'emotion_timeline', 'emotion_points', 'emotion_audit']) {
    out[t] = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE self_id=?`).get(self?.id ?? '').c
  }
  db.close()
  return out
}

test('dry-run 不创建目标库、不写任何东西', () => {
  const dir = tmpDir()
  const memory = pjoin(dir, 'memory.db')
  makeMemoryDb(memory)
  const persona = pjoin(dir, 'persona.db')
  const out = run([`--db=${persona}`, `--memory-db=${memory}`])
  assert.match(out, /DRY-RUN/)
  assert.match(out, /源行数：state 1 \/ timeline 2 \/ points 1 \/ audit 2/)
  assert.match(out, /目标库不存在/)
  assert.equal(existsSync(persona), false, 'dry-run 不得创建 persona.db')
})

test('dry-run 报告其他 session_key 会被跳过', () => {
  const dir = tmpDir()
  const memory = pjoin(dir, 'memory.db')
  makeMemoryDb(memory)
  const out = run([`--db=${pjoin(dir, 'persona.db')}`, `--memory-db=${memory}`])
  assert.match(out, /其他 session_key/)
  assert.match(out, /qq:other/)
})

test('apply：行数、映射、打码、msg_ref 都符合预期', () => {
  const dir = tmpDir()
  const memory = pjoin(dir, 'memory.db')
  makeMemoryDb(memory)
  const persona = pjoin(dir, 'persona.db')
  const out = run([`--db=${persona}`, `--memory-db=${memory}`, '--apply'])
  assert.match(out, /本次新增：timeline 2 \/ points 1 \/ audit 2/)
  const c = counts(persona)
  assert.match(c.selfId, /^self:/)
  assert.deepEqual([c.emotion_state, c.emotion_timeline, c.emotion_points, c.emotion_audit], [1, 2, 1, 2])

  const db = new DatabaseSync(persona, { readOnly: true })
  const st = db.prepare('SELECT * FROM emotion_state').get()
  assert.equal(st.valence, 0.31)
  assert.equal(st.label, '开心')
  assert.equal(st.certainty, 0.5, '源无 certainty → 默认 0.5')
  assert.equal(st.confidence, 0.63)
  const rows = db.prepare('SELECT * FROM emotion_timeline ORDER BY at').all()
  assert.equal(rows[1].trigger.includes('13800138000'), false, '手机号必须打码')
  assert.ok(rows.every((r) => r.msg_ref === ''), '源无 msg_ref → 空串')
  const pt = db.prepare('SELECT * FROM emotion_points').get()
  assert.equal(pt.msg_ref, 'explicit:sess-1:51', 'points 的 msg_ref 必须保留')
  const au = db.prepare('SELECT * FROM emotion_audit ORDER BY at').all()
  assert.equal(au[0].action, 'rule')
  assert.equal(au[1].action, 'rule-none')
  assert.ok(au.every((r) => r.note === 'from memory.db'))
  db.close()
})

test('幂等：重复 apply 不重复插入', () => {
  const dir = tmpDir()
  const memory = pjoin(dir, 'memory.db')
  makeMemoryDb(memory)
  const persona = pjoin(dir, 'persona.db')
  run([`--db=${persona}`, `--memory-db=${memory}`, '--apply'])
  const first = counts(persona)
  const out2 = run([`--db=${persona}`, `--memory-db=${memory}`, '--apply'])
  const second = counts(persona)
  assert.match(out2, /本次新增：timeline 0 \/ points 0 \/ audit 0/)
  assert.deepEqual(second, first)
})

test('回滚：删除本次插入并清除状态行；再回滚是 no-op', () => {
  const dir = tmpDir()
  const memory = pjoin(dir, 'memory.db')
  makeMemoryDb(memory)
  const persona = pjoin(dir, 'persona.db')
  run([`--db=${persona}`, `--memory-db=${memory}`, '--apply'])
  const dry = run([`--db=${persona}`, '--rollback'])
  assert.match(dry, /DRY-RUN/)
  run([`--db=${persona}`, '--rollback', '--apply'])
  const c = counts(persona)
  assert.deepEqual([c.emotion_state, c.emotion_timeline, c.emotion_points, c.emotion_audit], [0, 0, 0, 0])
  assert.match(c.selfId, /^self:/, '回滚不动 self 行')
  const again = run([`--db=${persona}`, '--rollback', '--apply'])
  assert.match(again, /没有迁移记录/)
})

test('回滚恢复被覆盖的状态行', () => {
  const dir = tmpDir()
  const memory = pjoin(dir, 'memory.db')
  makeMemoryDb(memory)
  const persona = pjoin(dir, 'persona.db')
  run([`--db=${persona}`, `--memory-db=${memory}`, '--apply'])
  const db = new DatabaseSync(persona)
  const selfId = db.prepare("SELECT id FROM self WHERE status='active'").get().id
  db.prepare('UPDATE emotion_state SET valence=0.99, arousal=0.88, label=?, intensity=0.99, updated_at=111 WHERE self_id=?').run('兴奋', selfId)
  db.close()
  run([`--db=${persona}`, `--memory-db=${memory}`, '--apply'])
  run([`--db=${persona}`, '--rollback', '--apply'])
  const after = new DatabaseSync(persona, { readOnly: true })
  const st = after.prepare('SELECT * FROM emotion_state').get()
  after.close()
  assert.equal(st.valence, 0.99, '回滚应恢复迁移前的状态行')
  assert.equal(st.label, '兴奋')
  assert.equal(Number(st.updated_at), 111)
})

test('生产路径被拒（persona.db 与线上 memory.db 都一样）', () => {
  const dir = tmpDir()
  const memory = pjoin(dir, 'memory.db')
  makeMemoryDb(memory)
  let err
  try {
    run([`--db=/sdcard/Documents/DSH记忆档案/persona/persona.db`, `--memory-db=${memory}`, '--apply'])
  } catch (e) {
    err = String(e.stderr ?? e.message)
  }
  assert.match(err ?? '', /拒绝操作生产库/)

  let err2
  try {
    run([`--db=${pjoin(dir, 'persona.db')}`, `--memory-db=/opt/qqai/dy-memory/memory.db`, '--apply'])
  } catch (e) {
    err2 = String(e.stderr ?? e.message)
  }
  assert.match(err2 ?? '', /拒绝直接读线上 memory.db/)

  // 2026-11-04 迁移后的新生产路径也要拦（dry-run，不写库；guard 在读库前就退出）
  let err3
  try {
    run([`--db=/sdcard/DSHA/人格/数据/persona.db`, `--memory-db=${memory}`])
  } catch (e) {
    err3 = String(e.stderr ?? e.message)
  }
  assert.match(err3 ?? '', /拒绝操作生产库/, '新 persona 生产路径必须被守卫')

  let err4
  try {
    run([`--db=${pjoin(dir, 'persona.db')}`, `--memory-db=/sdcard/DSHA/记忆/数据/memory.db`])
  } catch (e) {
    err4 = String(e.stderr ?? e.message)
  }
  assert.match(err4 ?? '', /拒绝直接读线上 memory.db/, '新 memory 生产路径必须被守卫')
})

test('源库只读：迁移不改 memory 副本', async () => {
  const dir = tmpDir()
  const memory = pjoin(dir, 'memory.db')
  makeMemoryDb(memory)
  const { createHash } = await import('node:crypto')
  const { readFileSync } = await import('node:fs')
  const h1 = createHash('sha256').update(readFileSync(memory)).digest('hex')
  run([`--db=${pjoin(dir, 'persona.db')}`, `--memory-db=${memory}`, '--apply'])
  const h2 = createHash('sha256').update(readFileSync(memory)).digest('hex')
  assert.equal(h1, h2)
})

