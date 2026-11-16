/** 离线注入：brief/full 只读临时 persona.db，验证长度/去重/子智能体隔离。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { ensureState } from '../lib/emotion.js'
import { bootPlugin, makeAgent, tmpDir, writeFixturePersona, FIXTURE_PERSONA } from './helpers/fixtures.mjs'

/** 加长版合成人格：让 full 与 brief 的差异可测（仍是合成内容）。 */
const LONG_PERSONA = `${FIXTURE_PERSONA}
# 价值观

- 不编造记忆，不确定就查档案
- 不替别人做不可逆决定
- 不因为情绪改写事实
- 不把工具结果当成用户说的话
- 不承诺做不到的事

# 边界

- 不泄露隐私
- 不刷屏
- 不写报告，不贴文件路径
- 不主动汇报进度
- 不在群里复述私聊内容
- 不编造见过谁、去过哪
- 不评价自己看不懂的代码
- 不把猜测说成事实
- 不在被质疑时急着讨好
- 不重复同一句话凑长度
- 不把情绪当理由推卸责任
- 不假装记得没发生过的事
`


const OWNER = '/tmp/fixture-owner-private'

/** 造一个带 self + 情绪状态的临时 persona.db。 */
function seedDb(dir, { label = '生气', intensity = 0.9, valence = -0.7, arousal = 0.9 } = {}) {
  const dbPath = join(dir, 'persona.db')
  const db = openDb(dbPath)
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  db.prepare(
    `UPDATE emotion_state SET valence=?, arousal=?, label=?, intensity=?, confidence=0.8, source='rule', updated_at=? WHERE self_id=?`,
  ).run(valence, arousal, label, intensity, Date.now(), self.id)
  db.close()
  return { dbPath, selfId: self.id }
}

async function boot({ mode = 'full', seed = {}, allowlist = [{ dir: OWNER, mode: 'full' }] } = {}) {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir, LONG_PERSONA)
  const { dbPath, selfId } = seedDb(dir, seed)
  const p = await bootPlugin({
    cfg: { dataDir: dir, dbPath, personaPath, inject: { mode, sessionDirs: allowlist } },
  })
  return { ...p, dir, dbPath, selfId }
}

function mountWith(ctx, { id = 'sess-offline', cwd = OWNER, header = {} } = {}) {
  const agent = makeAgent({ id, cwd, header })
  ctx.emit('agent/created', { agent })
  return agent
}

test('full：人格块来自临时 DB 的自体，长度 ≥ brief', async () => {
  const full = await boot({ mode: 'full' })
  const a = mountWith(full.ctx)
  const ctxPersona = a._registered.find((r) => r.name === 'dy-persona')
  assert.ok(ctxPersona, '应挂 dy-persona')
  const fullText = ctxPersona.text()
  assert.match(fullText, /^【人格核心】/)
  assert.ok(fullText.length > 300, `full 长度 ${fullText.length}`)

  const briefRun = await boot({ mode: 'brief', allowlist: [{ dir: OWNER, mode: 'brief' }] })
  const b = mountWith(briefRun.ctx)
  const briefText = b._registered.find((r) => r.name === 'dy-persona').text()
  assert.match(briefText, /^【人格核心·要点】/)
  assert.ok(briefText.length < fullText.length, `brief(${briefText.length}) 应短于 full(${fullText.length})`)
  assert.ok(fullText.length - briefText.length > 30, 'full 与 brief 要有可见差距')
  const body = briefText.replace(/^【人格核心·要点】\n/, '')
  assert.ok(body.length <= 250 + 20, `brief 正文 ${body.length} 应≈≤250`)
})

test('full 注入文本与 service.block() 一致（同一渲染路径）', async () => {
  const p = await boot({ mode: 'full' })
  const a = mountWith(p.ctx)
  const injected = a._registered.find((r) => r.name === 'dy-persona').text()
  assert.equal(injected, p.service.block().text)
})

test('情绪块：强度达标时 ≤60 字、无数字、稳定；低于阈值时为空', async () => {
  const hot = await boot({ mode: 'full', seed: { label: '生气', intensity: 0.9 } })
  const agent = mountWith(hot.ctx)
  const emo = agent._registered.find((r) => r.name === 'dy-emotion')
  const t1 = emo.text()
  assert.match(t1, /^【你现在的情绪】/)
  assert.ok(t1.length <= 60, `情绪块 ${t1.length} 字`)
  assert.doesNotMatch(t1, /\d/)
  assert.equal(emo.text(), t1, '同一标签下文本必须稳定（不重复追加）')

  const calm = await boot({ mode: 'full', seed: { label: '平静', intensity: 0.1, valence: 0, arousal: 0.1 } })
  const calmAgent = mountWith(calm.ctx)
  assert.equal(calmAgent._registered.find((r) => r.name === 'dy-emotion').text(), '')
})

test('去重：同一会话重复 created 只有两个 context；disposed 后清理', async () => {
  const p = await boot({ mode: 'full' })
  const agent = mountWith(p.ctx)
  p.ctx.emit('agent/created', { agent })
  assert.deepEqual(agent._registered.map((r) => r.name).sort(), ['dy-emotion', 'dy-emotion-act', 'dy-persona', 'dy-relationship', 'dy-voice'])
  p.ctx.emit('agent/disposed', { agent })
  assert.equal(agent._registered.length, 0)
})

test('真子智能体在 full/brief 下都不注入；parentSession fork 注入', async () => {
  for (const mode of ['full', 'brief']) {
    const p = await boot({ mode, allowlist: [{ dir: OWNER, mode }] })
    for (const header of [{ origin: 'subagent' }, { delegationDepth: 1 }]) {
      const agent = mountWith(p.ctx, { id: `sub-${mode}-${JSON.stringify(header)}`, header })
      assert.equal(agent._registered.length, 0, `${mode} 下 header=${JSON.stringify(header)} 不应注入`)
    }
    const fork = mountWith(p.ctx, { id: `fork-${mode}`, header: { parentSession: 'p', isSeeded: true, agentPreset: 'standard' } })
    assert.equal(fork._registered.length, 5, `${mode} 下 fork 应注入（含 dy-relationship）`)
  }
})

test('群聊与白名单外不注入（离线）', async () => {
  const p = await boot({ mode: 'full' })
  const group = mountWith(p.ctx, { id: 'g1', cwd: '/tmp/群_0000' })
  assert.equal(group._registered.length, 0)
  const other = mountWith(p.ctx, { id: 'o1', cwd: '/tmp/other-dir' })
  assert.equal(other._registered.length, 0)
})

test('注入只读：挂载与求值不往临时 DB 写行', async () => {
  const p = await boot({ mode: 'full' })
  const before = (() => {
    const db = new DatabaseSync(p.dbPath, { readOnly: true })
    const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
    const out = { timeline: n('emotion_timeline'), points: n('emotion_points'), audit: n('emotion_audit'), self: n('self') }
    db.close()
    return out
  })()
  const agent = mountWith(p.ctx)
  agent._registered.forEach((r) => r.text())
  p.service.block()
  p.service.emotion.state()
  const after = (() => {
    const db = new DatabaseSync(p.dbPath, { readOnly: true })
    const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
    const out = { timeline: n('emotion_timeline'), points: n('emotion_points'), audit: n('emotion_audit'), self: n('self') }
    db.close()
    return out
  })()
  assert.deepEqual(after, before, '读路径不得写库')
})

test('mode=off（默认）离线也不挂载', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const p = await bootPlugin({ cfg: { dataDir: dir, personaPath } })
  const agent = mountWith(p.ctx)
  assert.equal(agent._registered.length, 0)
  assert.equal(p.service.block().text, '')
})
