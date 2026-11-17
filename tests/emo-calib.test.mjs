/** 两个口径：why 在空 ref 时的返回；情绪阈值下的「连续为空」观测。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { ensureState, why } from '../lib/emotion.js'
import { createEmotionObserver } from '../lib/emo-observe.js'
import { bootPlugin, makeAgent, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const OWNER = '/tmp/fixture-owner-private'

test('口径 1：point 的 msg_ref 为空 → why 返回 msgRef="none"，不报错', () => {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  const at = Date.now() - 1000
  // 模拟旧迁移数据：trigger 与 msg_ref 都是空
  db.prepare('INSERT INTO emotion_points(self_id,at,dimension,delta,value_after,trigger,msg_ref) VALUES(?,?,?,?,?,?,?)')
    .run(self.id, at, 'arousal', 0.2, 0.5, '', '')
  const out = why(db, self.id, 6)
  assert.equal(out.length, 1)
  assert.equal(out[0].msgRef, 'none')
  assert.equal('trigger' in out[0], false, '空 trigger 不应出现该字段')
  assert.equal(out[0].delta, 0.2)
  db.close()
})

test('口径 1：窗口内没有转折点 → 返回空数组，不抛', () => {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  const out = why(db, self.id, 6)
  assert.deepEqual(out, [])
  db.close()
})

test('口径 1：includeTrigger=false 时即使有 trigger 也省略', () => {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  db.prepare('INSERT INTO emotion_points(self_id,at,dimension,delta,value_after,trigger,msg_ref) VALUES(?,?,?,?,?,?,?)')
    .run(self.id, Date.now(), 'valence', -0.3, -0.2, '某句触发', 'explicit:s:1')
  const withT = why(db, self.id, 6)
  const noT = why(db, self.id, 6, { includeTrigger: false })
  assert.equal(withT[0].trigger, '某句触发')
  assert.equal('trigger' in noT[0], false)
  assert.equal(noT[0].msgRef, 'explicit:s:1')
  db.close()
})

test('口径 2：连续为空到阈值才告警一次，非空即清零', () => {
  const warns = []
  const log = { warn: (m) => warns.push(m) }
  const ob = createEmotionObserver({ threshold: 0.35, warnEvery: 5, log })
  for (let i = 0; i < 4; i++) assert.equal(ob.sample(''), '')
  assert.equal(warns.length, 0, '未到阈值不告警')
  ob.sample('')
  assert.equal(warns.length, 1, '第 5 次应告警一次')
  assert.match(warns[0], /连续 5 次为空/)
  assert.match(warns[0], /0\.35/)
  ob.sample('【你现在的情绪】平静；这轮说话和平时差不多。')
  assert.equal(ob.stats().emptyStreak, 0, '非空要清零')
  assert.equal(ob.stats().lastNonEmptyAt > 0, true)
  for (let i = 0; i < 5; i++) ob.sample('')
  assert.equal(warns.length, 2, '再次到阈值应再告警一次')
  const s = ob.stats()
  assert.equal(s.calls, 11)
  assert.equal(s.empty, 10)
  assert.equal(s.maxEmptyStreak, 5)
  assert.equal(s.warnEvery, 5)
  assert.ok(s.emptyRatio > 0.9)
})

test('口径 2：service 的 dy_persona_mode 会带出情绪观测', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const p = await bootPlugin({
    cfg: {
      dataDir: dir,
      personaPath,
      emotion: { emptyStreakWarn: 2, threshold: 0.99 }, // 阈值拉高 → 必为空
      inject: { mode: 'full', sessionDirs: [{ dir: OWNER, mode: 'full' }] },
    },
  })
  const modeTool = p.tools.get('dy_persona_mode')
  const agent = makeAgent({ id: 's', cwd: OWNER })
  p.ctx.emit('agent/created', { agent })
  const emo = agent._registered.find((r) => r.name === 'dy-emotion')
  for (let i = 0; i < 3; i++) assert.equal(emo.text(), '')
  const res = await modeTool.execute({}, { agent })
  const detail = JSON.parse(res.detail)
  assert.equal(detail.emotion_threshold, 0.99)
  assert.ok(detail.emotion_stats, '应带 emotion_stats')
  assert.ok(detail.emotion_stats.calls >= 3, `calls=${detail.emotion_stats.calls}`)
  assert.ok(detail.emotion_stats.emptyStreak >= 3)
})

test('口径 2：观测只计数不写库', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const p = await bootPlugin({
    cfg: { dataDir: dir, personaPath, emotion: { threshold: 0.99 }, inject: { mode: 'full', sessionDirs: [OWNER] } },
  })
  const dbPath = join(dir, 'persona.db')
  const count = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
    const out = { timeline: n('emotion_timeline'), audit: n('emotion_audit'), meta: n('meta') }
    db.close()
    return out
  }
  const before = count()
  const agent = { session: { header: { id: 'x', cwd: OWNER } }, ctx: { systemPrompt: { context: () => () => {} } } }
  p.ctx.emit('agent/created', { agent })
  for (let i = 0; i < 5; i++) p.service._emotionLine()
  const after = count()
  assert.deepEqual(after, before)
})
