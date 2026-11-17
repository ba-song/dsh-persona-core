/**
 * 批次 B2：情绪 trigger 隐私阈值。
 * - 默认 60 字截断；0 = 不存 trigger，只留 msg_ref
 * - 入库（timeline/points）、溯源（why）、注入（dy-emotion）三条路径都不带出超阈值原文
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import {
  DEFAULTS,
  ensureState,
  ingestEmotion,
  masked,
  points,
  timeline,
  why,
} from '../lib/emotion.js'
import { bootPlugin, makeAgent, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const HOME = '/tmp/fixture-home'

function freshDb() {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  return { db, self }
}

test('B2-masked 数值语义：0/负数/非数字 = 空，正常值按字截断', () => {
  assert.equal(masked('abcdef', 0), '')
  assert.equal(masked('abcdef', '0'), '')
  assert.equal(masked('abcdef', -1), '')
  assert.equal(masked('abcdef', NaN), '')
  assert.equal(masked('abcdef', 3), 'abc')
  assert.equal(masked('13800138000 你好', 60), '（已省略） 你好')
})

test('B2-默认 60：超长 trigger 截断，60 字外的尾巴不进 timeline', () => {
  const { db, self } = freshDb()
  const tail = 'SECRET-TAIL-不该出现'
  const trigger = `有点烦${'啊'.repeat(80)}${tail}`
  ingestEmotion(db, self.id, { text: '有点烦', trigger, msgRef: 'explicit:b2:60', at: Date.now(), opts: DEFAULTS, forceAudit: true })
  const row = timeline(db, self.id, 24).at(-1)
  assert.equal(row.trigger.length, 60, `实际 ${row.trigger.length}`)
  assert.equal(row.trigger.includes(tail), false)
  assert.equal(row.msg_ref, 'explicit:b2:60')
  db.close()
})

test('B2-triggerMaxChars=0：timeline.points 都不存 trigger，只留 msg_ref', () => {
  const { db, self } = freshDb()
  const at = Date.now()
  ingestEmotion(db, self.id, {
    text: '气死我了',
    trigger: '这是一段完整的用户原话，不该入库',
    msgRef: 'explicit:b2:zero',
    at,
    opts: { ...DEFAULTS, triggerMaxChars: 0 },
    forceAudit: true,
  })
  const row = timeline(db, self.id, 24).at(-1)
  assert.equal(row.trigger, '')
  assert.equal(row.msg_ref, 'explicit:b2:zero', 'msg_ref 必须保留')
  const pts = points(db, self.id, 24)
  assert.ok(pts.length >= 1, '应有转折点')
  for (const p of pts) {
    assert.equal(p.trigger, '', 'points.trigger 也不存')
    assert.equal(p.msg_ref, 'explicit:b2:zero')
  }
  db.close()
})

test('B2-triggerMaxChars=0：why() 不返回 trigger 字段，msgRef 保留', () => {
  const { db, self } = freshDb()
  ingestEmotion(db, self.id, {
    text: '气死我了',
    trigger: '完整原话不该出现在 why',
    msgRef: 'explicit:b2:why',
    at: Date.now(),
    opts: { ...DEFAULTS, triggerMaxChars: 0 },
    forceAudit: true,
  })
  const out = why(db, self.id, 6)
  assert.ok(out.length >= 1)
  for (const p of out) {
    assert.equal('trigger' in p, false)
    assert.equal(p.msgRef, 'explicit:b2:why')
  }
  db.close()
})

test('B2-服务层：triggerMaxChars=0 时 service.emotion.why 也不带 trigger', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const p = await bootPlugin({
    cfg: { dataDir: dir, personaPath, emotion: { triggerMaxChars: 0 }, inject: { mode: 'full', sessionDirs: [HOME] } },
  })
  const db = new DatabaseSync(join(dir, 'persona.db'))
  const selfId = p.service.selfId()
  ensureState(db, selfId)
  ingestEmotion(db, selfId, {
    text: '气死我了',
    trigger: '完整原话不该出现在服务层 why',
    msgRef: 'explicit:b2:svc',
    at: Date.now(),
    opts: { ...DEFAULTS, triggerMaxChars: 0 },
    forceAudit: true,
  })
  db.close()
  const out = p.service.emotion.why(6, { header: { id: 's-owner', cwd: HOME } })
  assert.ok(out.points.length >= 1)
  for (const pt of out.points) {
    assert.equal('trigger' in pt, false)
    assert.equal(pt.msgRef, 'explicit:b2:svc')
  }
})

test('B2-注入块不带 trigger 正文（dy-emotion 只看 label/强度）', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const p = await bootPlugin({ cfg: { dataDir: dir, personaPath, inject: { mode: 'full', sessionDirs: [HOME] } } })
  const db = new DatabaseSync(join(dir, 'persona.db'))
  const selfId = p.service.selfId()
  ensureState(db, selfId)
  db.prepare("UPDATE emotion_state SET valence=-0.7, arousal=0.9, label='生气', intensity=0.9, updated_at=? WHERE self_id=?").run(Date.now(), selfId)
  db.prepare("INSERT INTO emotion_timeline(self_id,at,valence,arousal,label,intensity,trigger,msg_ref) VALUES(?,?,?,?,?,?,?,?)")
    .run(selfId, Date.now(), -0.7, 0.9, '生气', 0.9, '秘密原话ABC不该进注入', 'explicit:b2:inject')
  db.close()

  const agent = makeAgent({ id: 's-inject', cwd: HOME })
  p.ctx.emit('agent/created', { agent })
  const emo = agent._registered.find((r) => r.name === 'dy-emotion')
  assert.ok(emo, '应挂 dy-emotion')
  const text = emo.text()
  assert.match(text, /^【你现在的情绪】/)
  assert.equal(text.includes('秘密原话ABC'), false, '注入块不得带 trigger 正文')
})

test('B2-默认 60 的边界：61 字截到 60，61 字位置的内容不出现', () => {
  const { db, self } = freshDb()
  const trigger = `${'字'.repeat(60)}末`
  ingestEmotion(db, self.id, { text: '有点烦', trigger, msgRef: 'explicit:b2:61', at: Date.now(), opts: DEFAULTS, forceAudit: true })
  const row = timeline(db, self.id, 24).at(-1)
  assert.equal(row.trigger.length, 60)
  assert.equal(row.trigger.endsWith('末'), false)
  assert.equal(row.trigger, '字'.repeat(60))
  db.close()
})

test('B2-60 字外的尾巴不进 points / why', () => {
  const { db, self } = freshDb()
  const tail = 'TAIL-隐私尾巴'
  const trigger = `气死我了${'啊'.repeat(90)}${tail}`
  ingestEmotion(db, self.id, { text: '气死我了', trigger, msgRef: 'explicit:b2:tail', at: Date.now(), opts: DEFAULTS, forceAudit: true })
  const row = timeline(db, self.id, 24).at(-1)
  assert.equal(row.trigger.includes(tail), false)
  for (const pt of points(db, self.id, 24)) assert.equal(pt.trigger.includes(tail), false)
  for (const pt of why(db, self.id, 6)) assert.equal(String(pt.trigger ?? '').includes(tail), false)
  db.close()
})
