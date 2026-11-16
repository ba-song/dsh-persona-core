/** full/brief 压力：长人格、连续 50 次求值稳定、预算、去重、空情绪阈值、零写库。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { personaBlock } from '../lib/persona.js'
import { bootPlugin, makeAgent, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const OWNER = '/tmp/fixture-owner-private'
const RUNS = 50

/** 合成超长人格：约 6–8k 字（不含任何真实人格正文）。 */
function longPersona() {
  const parts = ['# 我是谁\n\n名字：{{display_name}}\n身份：压测用的合成人格，不是真实人设。\n']
  parts.push('# 性格\n\n')
  for (let i = 0; i < 60; i++) parts.push(`- 性格条目 ${i}：说得直，不绕弯，遇到事情先看事实再看情绪。\n`)
  parts.push('# 说话方式\n\n')
  for (let i = 0; i < 60; i++) parts.push(`- 说话条目 ${i}：短句，口语，不用表格，不写报告，不贴路径。\n`)
  parts.push('# 价值观\n\n')
  for (let i = 0; i < 45; i++) parts.push(`- 价值条目 ${i}：不编造记忆，不确定就查。\n`)
  parts.push('# 边界\n\n')
  for (let i = 0; i < 45; i++) parts.push(`- 边界条目 ${i}：不泄露隐私，不刷屏，不替别人做不可逆决定。\n`)
  return parts.join('')
}

function counts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const out = {}
  for (const t of ['self', 'name_history', 'persona_versions', 'emotion_state', 'emotion_timeline', 'emotion_points', 'emotion_audit']) {
    out[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
  }
  out.meta = db.prepare('SELECT COUNT(*) c FROM meta').get().c
  db.close()
  return out
}

async function bootWith({ persona, mode = 'full', emotion = {} } = {}) {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir, persona)
  const p = await bootPlugin({
    cfg: {
      dataDir: dir,
      personaPath,
      inject: { mode, sessionDirs: [{ dir: OWNER, mode }] },
      emotion,
    },
  })
  return { ...p, dir, dbPath: join(dir, 'persona.db') }
}

test('长人格（>5000 字）：full 完整、brief 受预算约束、都不抛', () => {
  const raw = longPersona()
  assert.ok(raw.length > 5000, `合成人格长度 ${raw.length}`)
  const full = personaBlock({ raw, displayName: '汐', mode: 'full' })
  assert.match(full.text, /^【人格核心】/)
  assert.ok(full.text.length >= raw.length, 'full 不应丢内容')
  assert.doesNotMatch(full.text, /\{\{display_name\}\}/)

  const brief = personaBlock({ raw, displayName: '汐', mode: 'brief', budget: 250 })
  const body = brief.text.replace(/^【人格核心·要点】\n/, '').replace(/\n（以上是你自己.*$/, '')
  assert.ok(body.length <= 270, `brief 正文 ${body.length} 超预算`)
  assert.ok(brief.text.length < full.text.length / 5, 'brief 应显著短于 full')
})

test('连续 50 次求值：full/brief 文本逐字节稳定', async () => {
  const p = await bootWith({ persona: longPersona() })
  const agent = makeAgent({ id: 'stress-1', cwd: OWNER })
  p.ctx.emit('agent/created', { agent })
  const personaCtx = agent._registered.find((r) => r.name === 'dy-persona')
  const first = personaCtx.text()
  for (let i = 0; i < RUNS; i++) assert.equal(personaCtx.text(), first, `第 ${i} 次求值变化`)
  // service.block 与注入文本同源
  assert.equal(p.service.block().text, first)
})

test('连续 50 次求值：情绪块稳定且不写库', async () => {
  const p = await bootWith({ persona: longPersona(), emotion: { threshold: 0.99 } }) // 阈值拉高 → 恒为空
  const before = counts(p.dbPath)
  const agent = makeAgent({ id: 'stress-2', cwd: OWNER })
  p.ctx.emit('agent/created', { agent })
  const emo = agent._registered.find((r) => r.name === 'dy-emotion')
  for (let i = 0; i < RUNS; i++) {
    assert.equal(emo.text(), '')
    p.service.emotion.state()
    p.service.block()
  }
  assert.deepEqual(counts(p.dbPath), before, '读路径不得写库')
})

test('情绪阈值边界：纯函数等于阈值注入、略低不注入；服务路径有衰减余量', async () => {
  // 1) 纯函数边界（严格 >= 阈值）
  const { emotionLine } = await import('../lib/emotion.js')
  assert.match(emotionLine({ label: '生气', intensity: 0.5 }, { threshold: 0.5 }), /【你现在的情绪】/)
  assert.equal(emotionLine({ label: '生气', intensity: 0.4999 }, { threshold: 0.5 }), '')
  assert.equal(emotionLine({ label: '生气', intensity: 0.5 }, { threshold: 0.51 }), '')

  // 2) 服务路径：状态是惰性衰减视图，用 0.9 / 0.1 的余量避开浮点衰减
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir, longPersona())
  const p = await bootPlugin({
    cfg: { dataDir: dir, personaPath, inject: { mode: 'full', sessionDirs: [OWNER] }, emotion: { threshold: 0.5 } },
  })
  const selfId = p.service.selfId()
  const setState = (valence, arousal) => {
    const db = new DatabaseSync(join(dir, 'persona.db'))
    db.prepare(
      "INSERT INTO emotion_state(self_id,valence,arousal,certainty,label,intensity,confidence,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?) " +
        'ON CONFLICT(self_id) DO UPDATE SET valence=excluded.valence, arousal=excluded.arousal, label=excluded.label, ' +
        'intensity=excluded.intensity, confidence=excluded.confidence, source=excluded.source, updated_at=excluded.updated_at',
    ).run(selfId, valence, arousal, 0.5, '生气', Math.max(Math.abs(valence), arousal), 0.8, 'rule', Date.now())
    db.close()
  }
  setState(-0.6, 0.9)
  assert.match(p.service._emotionLine(), /^【你现在的情绪】/)
  setState(-0.05, 0.1)
  assert.equal(p.service._emotionLine(), '', '强度 0.1 < 阈值 0.5 不注入')
})

test('去重：同一会话 50 次 created 仍只有 2 个 context；多会话各自独立', async () => {
  const p = await bootWith({ persona: longPersona() })
  const agent = makeAgent({ id: 'dup', cwd: OWNER })
  for (let i = 0; i < RUNS; i++) p.ctx.emit('agent/created', { agent })
  assert.deepEqual(agent._registered.map((r) => r.name).sort(), ['dy-emotion', 'dy-emotion-act', 'dy-persona', 'dy-relationship', 'dy-voice'])

  const agents = []
  for (let i = 0; i < 10; i++) {
    const a = makeAgent({ id: `multi-${i}`, cwd: OWNER })
    agents.push(a)
    p.ctx.emit('agent/created', { agent: a })
  }
  for (const a of agents) assert.equal(a._registered.length, 5)
  // 卸载其中一个不影响其他
  p.ctx.emit('agent/disposed', { agent: agents[0] })
  assert.equal(agents[0]._registered.length, 0)
  assert.equal(agents[1]._registered.length, 5)
})

test('brief 预算可配：budget=80 时正文明显更短，且不截断成半个标记', () => {
  const raw = longPersona()
  const tight = personaBlock({ raw, displayName: '汐', mode: 'brief', budget: 80 })
  const loose = personaBlock({ raw, displayName: '汐', mode: 'brief', budget: 400 })
  const body = (b) => b.text.replace(/^【人格核心·要点】\n/, '').replace(/\n（以上是你自己.*$/, '')
  assert.ok(body(tight).length <= 90, `tight ${body(tight).length}`)
  assert.ok(body(loose).length >= body(tight).length)
  assert.match(tight.text, /^【人格核心·要点】/)
})

test('改名后：full/brief 文本跟着变，但 version.hash 不变（模板未改）', async () => {
  const p = await bootWith({ persona: longPersona() })
  const before = p.service.block().text
  const hashBefore = p.service.version().hash
  const renameTool = p.tools.get('dy_persona_rename')
  const res = await renameTool.execute({ name: '小汐' }, { agent: makeAgent({ id: 'own', cwd: OWNER }) })
  assert.equal(res.ok, true)
  const after = p.service.block().text
  assert.notEqual(after, before)
  assert.match(after, /名字：小汐/)
  assert.equal(p.service.version().hash, hashBefore, '改名不改模板 → hash 不变')
})
