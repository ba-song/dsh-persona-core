/** 情绪：打分/衰减/注入/溯源/污染过滤/监听链路（F5/F6/F11/F12、N3/N4）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import {
  DEFAULTS,
  decayState,
  emotionLine,
  ensureState,
  ingestEmotion,
  isPolluted,
  points,
  scoreText,
  timeline,
  toneHintOf,
  why,
} from '../lib/emotion.js'
import { bootPlugin, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

function freshDb() {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  return { db, self }
}

test('F11 打分四象限 + 反讽降置信', () => {
  assert.ok(scoreText('太好了，我真的好开心！').valence > 0.4)
  assert.ok(scoreText('你怎么这样，我很难过').valence < -0.2)
  assert.ok(Math.abs(scoreText('今天一般').valence) < 0.15)
  assert.ok(scoreText('气死我了，烦死了！！').valence < -0.5)
  const plain = scoreText('真棒')
  const irony = scoreText('呵呵，真棒')
  assert.ok(irony.confidence < plain.confidence, '反讽必须降置信')
  assert.equal(irony.hits, plain.hits)
})

test('F12 不死锁：24h 后 |valence|<0.15，arousal 回落到基线附近', () => {
  const now = Date.now()
  const extreme = { valence: -0.95, arousal: 0.98, updated_at: now - 24 * 3600e3 }
  const view = decayState(extreme, now, DEFAULTS)
  assert.ok(Math.abs(view.valence) < 0.15, `valence=${view.valence}`)
  assert.ok(view.arousal < 0.25, `arousal=${view.arousal}`)
  // 不推动也算：6h 半衰
  const half = decayState({ valence: 0.8, arousal: 0.8, updated_at: now - 6 * 3600e3 }, now, DEFAULTS)
  assert.ok(Math.abs(half.valence - 0.4) < 0.02)
})

test('N3 注入行 ≤60 字、无数字、低于阈值不注入', () => {
  const line = emotionLine({ label: '生气', intensity: 0.8 }, { threshold: 0.35 })
  assert.ok(line.length <= 60, `长度 ${line.length}`)
  assert.doesNotMatch(line, /\d/)
  assert.match(line, /^【你现在的情绪】/)
  assert.equal(emotionLine({ label: '平静', intensity: 0.1 }, { threshold: 0.35 }), '')
})

test('N4 溯源：points 形状符合契约，含 trigger 与 msgRef', () => {
  const { db, self } = freshDb()
  const at = Date.now()
  ingestEmotion(db, self.id, { text: '太好了，我真的好开心！', trigger: '太好了，我真的好开心！', msgRef: 'explicit:s1:1', at, opts: DEFAULTS, forceAudit: true })
  const out = why(db, self.id, 6)
  assert.ok(out.length >= 1)
  const p = out[0]
  for (const key of ['at', 'dimension', 'delta', 'valueAfter', 'msgRef']) assert.ok(key in p, `缺 ${key}`)
  assert.equal(p.msgRef, 'explicit:s1:1')
  assert.ok(typeof p.trigger === 'string')
  // includeTrigger:false → 省略 trigger
  const noTrigger = why(db, self.id, 6, { includeTrigger: false })
  assert.equal('trigger' in noTrigger[0], false)
  db.close()
})

test('情绪只按 self_id 存：换名字/换 key 不受影响', () => {
  const { db, self } = freshDb()
  const at = Date.now()
  ingestEmotion(db, self.id, { text: '好开心', trigger: '好开心', msgRef: 'x', at, opts: DEFAULTS, forceAudit: true })
  assert.equal(timeline(db, self.id, 24).length, 1)
  assert.equal(timeline(db, 'self:other', 24).length, 0)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM emotion_state').get().c, 1)
  db.close()
})

test('trigger 截断与打码；triggerMaxChars=0 时不存', () => {
  const { db, self } = freshDb()
  const at = Date.now()
  ingestEmotion(db, self.id, {
    text: '好开心',
    trigger: `手机号 13800138000 还有一段很长的正文 ${'啊'.repeat(200)}`,
    msgRef: 'explicit:s2:9',
    at,
    opts: { ...DEFAULTS, triggerMaxChars: 20 },
    forceAudit: true,
  })
  const row = timeline(db, self.id, 24).at(-1)
  assert.ok(row.trigger.length <= 20, `trigger 长度 ${row.trigger.length}`)
  assert.equal(row.trigger.includes('13800138000'), false, '号码应被打码')
  ingestEmotion(db, self.id, { text: '好开心', trigger: '正文', msgRef: 'explicit:s2:10', at: at + 1, opts: { ...DEFAULTS, triggerMaxChars: 0 }, forceAudit: true })
  const row2 = timeline(db, self.id, 24).at(-1)
  assert.equal(row2.trigger, '')
  db.close()
})

test('F5 注入块回灌不产生候选：isPolluted 覆盖所有注入前缀', () => {
  for (const text of [
    '【人格核心】我是谁',
    '【你现在的情绪】平静；这轮说话和平时差不多。',
    '【记忆·事实卡】某条',
    'Current runtime context: foo',
    'SCHEDULE REMINDER 到点',
    '<system>自检</system>',
  ]) {
    assert.equal(isPolluted(text), true, `应判为污染：${text.slice(0, 12)}`)
  }
  assert.equal(isPolluted('主人今天好累'), false)
  assert.equal(isPolluted('太好了'), false)
})

test('无命中/低置信不写时间线、不改状态', () => {
  const { db, self } = freshDb()
  const before = db.prepare('SELECT * FROM emotion_state WHERE self_id=?').get(self.id)
  const r = ingestEmotion(db, self.id, { text: '今天出门走了走', at: Date.now(), opts: DEFAULTS, forceAudit: true })
  assert.equal(r.applied, false)
  assert.equal(timeline(db, self.id, 24).length, 0)
  const after = db.prepare('SELECT * FROM emotion_state WHERE self_id=?').get(self.id)
  assert.equal(after.updated_at, before.updated_at)
  db.close()
})

test('转折点阈值：小幅变化不记点，大幅变化记点', () => {
  const { db, self } = freshDb()
  const at = Date.now()
  ingestEmotion(db, self.id, { text: '还行', trigger: '', msgRef: 'a', at, opts: DEFAULTS })
  const small = points(db, self.id, 24).length
  ingestEmotion(db, self.id, { text: '气死我了，烦死了！！', trigger: '气死我了', msgRef: 'b', at: at + 1, opts: DEFAULTS })
  assert.ok(points(db, self.id, 24).length > small, '大变化应记点')
  db.close()
})

test('toneHint 与 emotionLine 一致地来自 label', () => {
  const hint = toneHintOf({ label: '生气', intensity: 0.9 })
  assert.ok(hint.length <= 40)
  assert.match(hint, /生气/)
})

test('F5/F6 监听链路：只处理主人私聊 user/message，注入块与工具结果不产生情绪', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const OWNER = '/tmp/fixture-owner-private'
  const { ctx } = await bootPlugin({
    cfg: {
      personaPath,
      emotion: { ingestEnabled: true },
      inject: { mode: 'full', sessionDirs: [{ dir: OWNER, mode: 'full' }] },
    },
  })
  const session = { header: { id: 'sess-owner', cwd: OWNER } }
  const userMsg = (text, seq = 1, kind = 'user') => ({ type: 'user/message', seq, time: Date.now(), data: { source: { kind }, content: [{ type: 'text', text }] } })

  ctx.emit('session/event', session, userMsg('谢谢你，真棒！', 1))
  const first = ctx.get('dyPersona').emotion.state()
  assert.ok(first.valence > 0.05, '正面消息应提高 valence')

  // 注入块回灌
  ctx.emit('session/event', session, userMsg('【人格核心】我是谁', 2))
  // 工具结果
  ctx.emit('session/event', session, { type: 'tool/result', seq: 3, time: Date.now(), data: { content: [{ type: 'text', text: '气死我了' }] } })
  // 非 user 来源
  ctx.emit('session/event', session, userMsg('气死我了，烦死了！！', 4, 'system'))
  // 群聊会话
  ctx.emit('session/event', { header: { id: 'g', cwd: '/tmp/群_000' } }, userMsg('气死我了', 5))
  // 子智能体会话
  ctx.emit('session/event', { header: { id: 'sub', cwd: OWNER, origin: 'subagent' } }, userMsg('气死我了', 6))

  const after = ctx.get('dyPersona').emotion.state()
  // state() 是惰性衰减视图，两次调用间有微秒级衰减，用容差比较；真被污染会差 0.1 以上
  assert.ok(Math.abs(after.valence - first.valence) < 1e-6, `上述事件都不应改变状态（${after.valence} vs ${first.valence}）`)
})

test('F5 重复 msgRef 只处理一次', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const OWNER = '/tmp/fixture-owner-private'
  const { ctx } = await bootPlugin({
    cfg: { personaPath, emotion: { ingestEnabled: true }, inject: { mode: 'full', sessionDirs: [OWNER] } },
  })
  const session = { header: { id: 'sess-dup', cwd: OWNER } }
  const ev = { type: 'user/message', seq: 7, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: '谢谢你，好开心！' }] } }
  ctx.emit('session/event', session, ev)
  const once = ctx.get('dyPersona').emotion.state()
  ctx.emit('session/event', session, ev) // 同一 seq：应被去重
  const twice = ctx.get('dyPersona').emotion.state()
  // state() 是惰性衰减视图，两次调用间有微秒级衰减；重复计入会差 ~0.1，用容差区分
  assert.ok(
    Math.abs(twice.valence - once.valence) < 1e-6,
    `同一 msgRef 不应重复计入（${once.valence} → ${twice.valence}）`,
  )
})
