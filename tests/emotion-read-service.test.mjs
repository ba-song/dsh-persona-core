/**
 * 情绪只读接口：emotionAt / emotionTimeline（给记忆回填用）。
 * 只读、无权限门、不返回 trigger/msg_ref；缺表/无数据不抛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { createPersonaService } from '../lib/service.js'
import { loadConfig } from '../lib/config.js'
import { bootPlugin, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const NOW = 1_700_000_000_000

function insertRow(dir, selfId, { at, label = '平静', intensity = 0.3, valence = 0.1, arousal = 0.3 }) {
  const db = new DatabaseSync(join(dir, 'persona.db'))
  db.prepare('INSERT INTO emotion_timeline(self_id,at,valence,arousal,label,intensity,trigger,msg_ref) VALUES(?,?,?,?,?,?,?,?)')
    .run(selfId, at, valence, arousal, label, intensity, '不该泄露的触发句', 'explicit:test:1')
  db.close()
}

async function boot() {
  const dir = tmpDir()
  const p = await bootPlugin({ cfg: { dataDir: dir, personaPath: writeFixturePersona(dir) } })
  return { p, dir }
}

test('emotionAt：窗口内返回最近一条，结构只含情绪数值/标签（无正文）', async () => {
  const { p, dir } = await boot()
  const selfId = p.service.selfId()
  insertRow(dir, selfId, { at: NOW - 300_000, label: '旧', intensity: 0.2, valence: -0.1, arousal: 0.2 })
  insertRow(dir, selfId, { at: NOW + 60_000, label: '近', intensity: 0.7, valence: 0.5, arousal: 0.7 })
  insertRow(dir, selfId, { at: NOW + 400_000, label: '远', intensity: 0.4, valence: 0.2, arousal: 0.4 })

  const hit = p.service.emotionAt(NOW, { windowMs: 600_000 })
  assert.ok(hit)
  assert.equal(hit.at, NOW + 60_000)
  assert.equal(hit.label, '近')
  assert.equal(hit.intensity, 0.7)
  assert.equal(hit.valence, 0.5)
  assert.equal(hit.arousal, 0.7)
  assert.deepEqual(Object.keys(hit).sort(), ['arousal', 'at', 'confidence', 'intensity', 'label', 'valence'])
  assert.equal('trigger' in hit, false, '不得泄露触发句')
  assert.equal('msg_ref' in hit, false)
})

test('emotionAt：窗口外返回 null；窗口边界包含', async () => {
  const { p, dir } = await boot()
  const selfId = p.service.selfId()
  insertRow(dir, selfId, { at: NOW + 600_000, label: '边界' })
  assert.equal(p.service.emotionAt(NOW, { windowMs: 10_000 }), null)
  assert.equal(p.service.emotionAt(NOW, { windowMs: 600_000 }).label, '边界')
})

test('emotionTimeline：按时间倒序 + limit + from/to 过滤', async () => {
  const { p, dir } = await boot()
  const selfId = p.service.selfId()
  for (let i = 0; i < 5; i++) insertRow(dir, selfId, { at: NOW - i * 3_600_000, label: `L${i}` })
  const rows = p.service.emotionTimeline({ from: NOW - 5 * 3_600_000, to: NOW + 1, limit: 2 })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].at, NOW)
  assert.equal(rows[0].label, 'L0')
  assert.equal(rows[1].at, NOW - 3_600_000)
  assert.ok(rows[0].at > rows[1].at)

  const windowRows = p.service.emotionTimeline({ from: NOW - 2 * 3_600_000, to: NOW - 3_600_000 + 1, limit: 20 })
  assert.deepEqual(windowRows.map((r) => r.label), ['L1', 'L2'])
})

test('emotionTimeline：无数据/空范围返回 []，不抛', async () => {
  const { p } = await boot()
  assert.deepEqual(p.service.emotionTimeline({}), [])
  assert.deepEqual(p.service.emotionTimeline({ from: NOW, to: NOW - 1 }), [])
  assert.deepEqual(p.service.emotionTimeline({ limit: 0 }), [])
})

test('emotionAt/emotionTimeline：缺表降级（null/[]，不抛）', () => {
  const dir = tmpDir()
  const db = openDb(join(dir, 'persona.db'))
  const self = ensureSelf(db, '汐')
  db.exec('DROP TABLE emotion_timeline')
  const cfg = loadConfig({ dataDir: dir, personaPath: join(dir, 'persona.md') })
  const svc = createPersonaService({ db: () => db, cfg, self: () => self })
  assert.equal(svc.emotionAt(NOW), null)
  assert.deepEqual(svc.emotionTimeline({}), [])
  db.close()
})

test('emotionAt/emotionTimeline：timeline 若未来有 confidence 列，返回数值（当前为 null）', () => {
  const dir = tmpDir()
  const db = openDb(join(dir, 'persona.db'))
  const self = ensureSelf(db, '汐')
  db.exec('ALTER TABLE emotion_timeline ADD COLUMN confidence REAL')
  db.prepare('INSERT INTO emotion_timeline(self_id,at,valence,arousal,label,intensity,trigger,msg_ref,confidence) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(self.id, NOW, 0.2, 0.4, '开心', 0.4, '正文', 'explicit:t:1', 0.42)
  const cfg = loadConfig({ dataDir: dir, personaPath: join(dir, 'persona.md') })
  const svc = createPersonaService({ db: () => db, cfg, self: () => self })
  assert.equal(svc.emotionAt(NOW).confidence, 0.42)
  assert.equal(svc.emotionTimeline({ from: NOW - 1, to: NOW + 1 })[0].confidence, 0.42)
  db.close()
})

test('两个接口只读：调用前后 timeline 行数不变', async () => {
  const { p, dir } = await boot()
  const selfId = p.service.selfId()
  insertRow(dir, selfId, { at: NOW })
  const count = () => {
    const db = new DatabaseSync(join(dir, 'persona.db'))
    const c = db.prepare('SELECT COUNT(*) c FROM emotion_timeline').get().c
    db.close()
    return c
  }
  const before = count()
  p.service.emotionAt(NOW)
  p.service.emotionTimeline({ from: NOW - 1000, to: NOW + 1000 })
  assert.equal(count(), before)
})
