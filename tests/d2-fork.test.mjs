/**
 * 批次 D2：fork 不再被误判成子智能体。
 * 只读验证：宿主 fork 写 parentSession + isSeeded + agentPreset，不写 origin/depth；
 * 真子智能体写 origin='subagent' + delegationDepth>=1。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { ensureBindingsTable, bindSession } from '../lib/bindings.js'
import { classify, isDelegatedSubagent, isSubagent, SCOPES } from '../lib/scope.js'
import { bootPlugin, makeAgent, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const HOME = '/tmp/fixture-home'
const ELSEWHERE = '/tmp/fixture-elsewhere'
// 宿主 GUI fork 的真实 header 形状（代码证据见报告 §1）
const FORK = { parentSession: 'parent-session', isSeeded: true, agentPreset: 'standard' }

function seed(dir, { bindingFor } = {}) {
  const db = openDb(join(dir, 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureBindingsTable(db)
  if (bindingFor) {
    bindSession(db, { sessionId: bindingFor, personaId: self.id, role: 'persona', cwd: ELSEWHERE, source: 'default', now: 10 })
  }
  return { db, self }
}

async function bootDir(dir, cfg = {}) {
  return bootPlugin({
    cfg: { dataDir: dir, personaPath: writeFixturePersona(dir), inject: { mode: 'full', sessionDirs: [HOME] }, ...cfg },
  })
}

function mount(p, { id, cwd, header = {} }) {
  const agent = makeAgent({ id, cwd, header })
  p.ctx.emit('agent/created', { agent })
  return agent
}

function rowsAt(dir) {
  const db = new DatabaseSync(join(dir, 'persona.db'))
  const rows = db.prepare('SELECT * FROM session_bindings ORDER BY created_at').all()
  db.close()
  return rows
}

test('D2-判据：parentSession 单独不算子智能体；origin/depth 才算', () => {
  assert.equal(isDelegatedSubagent({ parentSession: 'p' }), false)
  assert.equal(isDelegatedSubagent(FORK), false, '宿主 fork 只有 parentSession/isSeeded/agentPreset')
  assert.equal(isDelegatedSubagent({ origin: 'subagent' }), true)
  assert.equal(isDelegatedSubagent({ delegationDepth: 1 }), true)
  assert.equal(isDelegatedSubagent({ parentSession: 'p', delegationDepth: 0 }), false)
  // 可见性轴继续用严格口径（契约 §4）：parentSession 也算
  assert.equal(isSubagent(FORK), true)
})

test('D2-classify：fork→private、真子智能体→subagent、群→group', () => {
  assert.equal(classify({ ...FORK, cwd: HOME }), SCOPES.PRIVATE)
  assert.equal(classify({ cwd: HOME, origin: 'subagent' }), SCOPES.SUBAGENT)
  assert.equal(classify({ cwd: HOME, delegationDepth: 2 }), SCOPES.SUBAGENT)
  assert.equal(classify({ cwd: '/tmp/qq/群_1' }), SCOPES.GROUP)
})

test('D2-GUI fork（只有 parentSession）在 cwd 白名单内 → 正常注入', async () => {
  const dir = tmpDir()
  seed(dir).db.close()
  const p = await bootDir(dir)
  const agent = mount(p, { id: 's-fork-home', cwd: HOME, header: FORK })
  assert.equal(agent._registered.length, 4, 'fork 应注入 dy-persona/dy-emotion')
  assert.match(agent._registered.find((r) => r.name === 'dy-persona').text(), /^【人格核心】/)
})

test('D2-GUI fork + 历史 binding（cwd 不在白名单）→ 按 binding 注入', async () => {
  const dir = tmpDir()
  seed(dir, { bindingFor: 's-fork-bound' }).db.close()
  const p = await bootDir(dir)
  const agent = mount(p, { id: 's-fork-bound', cwd: ELSEWHERE, header: FORK })
  assert.equal(agent._registered.length, 4, 'binding 命中的 fork 应注入')
  assert.match(agent._registered.find((r) => r.name === 'dy-persona').text(), /^【人格核心】/)
})

test('D2-真子智能体 origin=subagent 仍拒，且不写 binding', async () => {
  const dir = tmpDir()
  seed(dir).db.close()
  const p = await bootDir(dir)
  const agent = mount(p, { id: 's-sub-origin', cwd: HOME, header: { parentSession: 'p', origin: 'subagent' } })
  assert.equal(agent._registered.length, 0)
  assert.equal(rowsAt(dir).some((r) => r.session_id === 's-sub-origin'), false)
})

test('D2-真子智能体 delegationDepth>0 仍拒，且不写 binding', async () => {
  const dir = tmpDir()
  seed(dir).db.close()
  const p = await bootDir(dir)
  const agent = mount(p, { id: 's-sub-depth', cwd: HOME, header: { parentSession: 'p', delegationDepth: 3 } })
  assert.equal(agent._registered.length, 0)
  assert.equal(rowsAt(dir).some((r) => r.session_id === 's-sub-depth'), false)
})

test('D2-无血缘标记的普通会话照常注入', async () => {
  const dir = tmpDir()
  seed(dir).db.close()
  const p = await bootDir(dir)
  const agent = mount(p, { id: 's-normal', cwd: HOME })
  assert.equal(agent._registered.length, 4)
})

test('D2-群聊仍拒（即使带 parentSession）', async () => {
  const dir = tmpDir()
  seed(dir).db.close()
  const p = await bootDir(dir, { inject: { mode: 'full', sessionDirs: ['/tmp/fixture-qq'] } })
  const agent = mount(p, { id: 's-group-fork', cwd: '/tmp/fixture-qq/群_42', header: FORK })
  assert.equal(agent._registered.length, 0)
})

test('D2-可见性轴不变：fork 读 emotion.why 仍 E_PERMISSION（契约 §4）', async () => {
  const dir = tmpDir()
  seed(dir).db.close()
  const p = await bootDir(dir)
  assert.throws(
    () => p.service.emotion.why(6, { header: { id: 's-fork-home', cwd: HOME, ...FORK } }),
    /E_PERMISSION/,
    'fork 可以有人格，但不能读 owner 情绪溯源',
  )
  // 普通主人会话仍可读
  assert.deepEqual(Object.keys(p.service.emotion.why(6, { header: { id: 's-owner', cwd: HOME } })), ['points'])
})
