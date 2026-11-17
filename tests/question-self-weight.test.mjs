/**
 * 问句衰减 + 她自己的 assistant 消息小幅参与情绪。
 * 问句：陈述权重的 questionWeight（默认 0.25）；自身：selfWeight（默认 0.3），只认明确情绪词、问句不算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { DEFAULTS, ensureState, ingestEmotion, isQuestion } from '../lib/emotion.js'
import { loadConfig } from '../lib/config.js'
import { bootPlugin, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const HOME = '/tmp/fixture-home'

function freshDb() {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  return { db, self }
}

function ingest(db, self, text, { self: isSelf = false, opts = {} } = {}) {
  return ingestEmotion(db, self.id, {
    text,
    msgRef: `explicit:q:${Math.random().toString(16).slice(2)}`,
    at: Date.now(),
    opts: { ...DEFAULTS, ...opts },
    self: isSelf,
    forceAudit: true,
  })
}

function delta(db, self) {
  const row = db.prepare('select valence from emotion_state where self_id=?').get(self.id)
  db.close()
  return Number(row.valence)
}

test('isQuestion：结尾问号/吗呢吧嘛、开头是不是/是否/难道都算；陈述不算', () => {
  for (const q of ['我不开心吗', '你不开心吗', '开心吗', '开心呢', '走吧', '开心嘛', '是不是不开心', '是否开心', '难道不开心', '不开心？', '不开心?', '不开心吗？']) {
    assert.equal(isQuestion(q), true, `应算问句：${q}`)
  }
  for (const s of ['我不开心', '今天不开心。', '我不是很开心', '好开心啊！', '吃饭了']) {
    assert.equal(isQuestion(s), false, `不应算问句：${s}`)
  }
})

test('问句负向：影响约为陈述的 0.25，不满权重扣分', () => {
  // 这里只测问句权重：关掉单条限速（默认 0.12 会把强陈述压到上限，比例失真）
  const uncapped = { maxDeltaPerMessage: 1 }
  const a = freshDb()
  ingest(a.db, a.self, '我不开心', { opts: uncapped })
  const statement = delta(a.db, a.self)

  const b = freshDb()
  ingest(b.db, b.self, '我不开心吗', { opts: uncapped })
  const question = delta(b.db, b.self)

  assert.ok(statement < -0.05, `陈述应扣分，实际 ${statement}`)
  assert.ok(question < 0, `问句仍应轻微负向，实际 ${question}`)
  assert.ok(Math.abs(question) <= Math.abs(statement) * 0.26, `问句 ${question} 应 ≤0.25×陈述 ${statement}`)
  assert.ok(Math.abs(question) >= Math.abs(statement) * 0.24, `问句 ${question} 应接近 0.25×陈述 ${statement}`)
})

test('问句正向：开心吗只小幅加分，不小于 0', () => {
  // 同上：关掉单条限速，只比问句权重
  const uncapped = { maxDeltaPerMessage: 1 }
  const a = freshDb()
  ingest(a.db, a.self, '开心', { opts: uncapped })
  const statement = delta(a.db, a.self)
  const b = freshDb()
  ingest(b.db, b.self, '开心吗', { opts: uncapped })
  const question = delta(b.db, b.self)
  assert.ok(statement > 0.05)
  assert.ok(question > 0)
  assert.ok(question <= statement * 0.26, `开心吗 ${question} 应 ≤0.25×开心 ${statement}`)
})

test('questionWeight 可配：0.1 时影响更小；非法值回落 0.25', () => {
  const a = freshDb()
  ingest(a.db, a.self, '我不开心吗', { opts: { questionWeight: 0.1 } })
  const w01 = delta(a.db, a.self)
  const b = freshDb()
  ingest(b.db, b.self, '我不开心吗', { opts: { questionWeight: 0.9 } })
  const w09 = delta(b.db, b.self)
  assert.ok(Math.abs(w01) < Math.abs(w09), '权重 0.1 的影响应小于 0.9')
  const cfg = loadConfig({ emotion: { questionWeight: 'x', selfWeight: 2 } })
  assert.equal(cfg.emotion.questionWeight, 0.25)
  assert.equal(cfg.emotion.selfWeight, 0.3)
})

// ── 她自己的消息（assistant/message） ────────────────────────────────
function selfMsg(text, seq = 1, extra = []) {
  return {
    type: 'assistant/message',
    seq,
    time: Date.now(),
    data: { message: { role: 'assistant', content: [...extra, { type: 'text', text }] } },
  }
}

async function boot(selfWeight = 0.3) {
  const dir = tmpDir()
  const p = await bootPlugin({
    cfg: {
      dataDir: dir,
      personaPath: writeFixturePersona(dir),
      inject: { mode: 'full', sessionDirs: [HOME] },
      emotion: { ingestEnabled: true, selfWeight },
    },
  })
  return p
}

test('她自己的「开心」：小幅加分，约为用户陈述的 0.3；问句/无情绪词不算', async () => {
  const p = await boot(0.3)
  const h = { id: 'self-1', cwd: HOME }
  p.ctx.emit('session/event', { header: h }, selfMsg('我好开心'))
  const selfValence = p.service.emotion.state().valence
  assert.ok(selfValence > 0, `自己的开心应小幅加分，实际 ${selfValence}`)
  assert.ok(selfValence < 0.1, `自身权重应小，实际 ${selfValence}`)

  const p2 = await boot(0.3)
  p2.ctx.emit('session/event', { header: { id: 'user-1', cwd: HOME } }, {
    type: 'user/message',
    seq: 1,
    time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '谢谢你' }] },
  })
  const userValence = p2.service.emotion.state().valence
  assert.ok(selfValence <= userValence * 0.5, `自身 ${selfValence} 应约为用户 owner_act ${userValence} 的 0.3–0.5 倍`)

  // 自己的问句不参与
  const p3 = await boot(0.3)
  p3.ctx.emit('session/event', { header: { id: 'self-2', cwd: HOME } }, selfMsg('我开心吗'))
  assert.equal(p3.service.emotion.state().valence, 0, '自己的问句不应加分')

  // 无明确情绪词不参与
  const p4 = await boot(0.3)
  p4.ctx.emit('session/event', { header: { id: 'self-3', cwd: HOME } }, selfMsg('今天吃了饭'))
  assert.equal(p4.service.emotion.state().valence, 0, '无情绪词不应改变')
})

test('selfWeight=0 关掉自身影响；reasoning 里的情绪词不算（只认 text）', async () => {
  const p = await boot(0)
  p.ctx.emit('session/event', { header: { id: 'self-off', cwd: HOME } }, selfMsg('我好开心'))
  assert.equal(p.service.emotion.state().valence, 0, 'selfWeight=0 应关闭')

  const p2 = await boot(0.3)
  p2.ctx.emit(
    'session/event',
    { header: { id: 'self-reason', cwd: HOME } },
    selfMsg('嗯', 1, [{ type: 'reasoning', text: '气死我了，我一点都不开心' }]),
  )
  assert.equal(p2.service.emotion.state().valence, 0, 'reasoning 不应参与情绪')
})
