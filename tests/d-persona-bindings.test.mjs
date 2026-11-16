/**
 * 批次 D：身份轴 session_bindings（写入 / 读取 / 注入判定 / 降级）。
 * 全部临时库，不读不写生产库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { ensureState } from '../lib/emotion.js'
import { ensureBindingsTable, bindSession, getBinding } from '../lib/bindings.js'
import { createInjector } from '../lib/inject.js'
import { loadConfig } from '../lib/config.js'
import { bootPlugin, makeAgent, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const HOME = '/tmp/fixture-home'
const ELSEWHERE = '/tmp/fixture-elsewhere'

function seedDb(dir) {
  const db = openDb(join(dir, 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  ensureBindingsTable(db)
  return { db, self }
}

async function bootWith(dir, cfg, personaPath) {
  const p = await bootPlugin({
    cfg: { dataDir: dir, personaPath: personaPath ?? writeFixturePersona(dir), ...cfg },
  })
  return p
}

function openDbAt(dir) {
  return new DatabaseSync(join(dir, 'persona.db'))
}

function rowsAt(dir) {
  const db = openDbAt(dir)
  const rows = db.prepare('SELECT * FROM session_bindings ORDER BY created_at').all()
  db.close()
  return rows
}

function mount(p, { id, cwd, header = {} }) {
  const agent = makeAgent({ id, cwd, header })
  p.ctx.emit('agent/created', { agent })
  return agent
}

test('D1 bindSession 幂等：同会话只 1 行，created_at 不变；不同 persona 不覆盖旧行', () => {
  const dir = tmpDir()
  const { db, self } = seedDb(dir)
  bindSession(db, { sessionId: 's1', personaId: self.id, cwd: '/tmp/a', source: 'default', now: 1000 })
  bindSession(db, { sessionId: 's1', personaId: self.id, cwd: '/tmp/b', source: 'default', now: 2000 })
  let row = getBinding(db, 's1')
  assert.equal(row.created_at, 1000, 'created_at 应保留第一次')
  assert.equal(row.cwd, '/tmp/b', '同 persona 允许刷新 cwd')
  // 不同 persona：不覆盖旧行
  bindSession(db, { sessionId: 's1', personaId: 'self:other', cwd: '/tmp/c', now: 3000 })
  row = getBinding(db, 's1')
  assert.equal(row.persona_id, self.id, '不同 persona 不得覆盖旧行')
  assert.equal(row.cwd, '/tmp/b')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM session_bindings WHERE session_id=?').get('s1').c, 1)
  db.close()
})

test('D2 cwd 命中 bind.cwdPrefixes 时写入 persona 绑定；不命中不写', async () => {
  const dir = tmpDir()
  seedDb(dir).db.close()
  const p = await bootWith(dir, { inject: { mode: 'full', sessionDirs: [HOME] } })
  mount(p, { id: 's-home', cwd: HOME })
  mount(p, { id: 's-other', cwd: ELSEWHERE })
  const rows = rowsAt(dir)
  const homeRow = rows.find((r) => r.session_id === 's-home')
  assert.ok(homeRow, '命中前缀应写入')
  assert.equal(homeRow.role, 'persona')
  assert.equal(homeRow.persona_id, p.service.selfId())
  assert.equal(homeRow.source, 'default')
  assert.equal(rows.some((r) => r.session_id === 's-other'), false, '不命中不写')
})

test('D3 binding 命中即注入：cwd 不在白名单也能挂 full', async () => {
  const dir = tmpDir()
  const { db, self } = seedDb(dir)
  bindSession(db, { sessionId: 's-bound', personaId: self.id, role: 'persona', cwd: ELSEWHERE, source: 'default', now: 10 })
  db.close()
  const p = await bootWith(dir, { inject: { mode: 'full', sessionDirs: [HOME] } })
  const agent = mount(p, { id: 's-bound', cwd: ELSEWHERE })
  const names = agent._registered.map((r) => r.name).sort()
  // 2026-11-16：新增 dy-relationship(913)
  assert.deepEqual(names, ['dy-emotion', 'dy-emotion-act', 'dy-persona', 'dy-relationship', 'dy-voice'])
  assert.equal(agent._registered.find((r) => r.name === 'dy-persona').order, 900)
  assert.match(agent._registered.find((r) => r.name === 'dy-persona').text(), /^【人格核心】/)
})

test('D4 binding 指向别的 persona：不注入，也不改旧行', async () => {
  const dir = tmpDir()
  const { db } = seedDb(dir)
  bindSession(db, { sessionId: 's-alien', personaId: 'self:other', role: 'persona', cwd: ELSEWHERE, source: 'default', now: 10 })
  db.close()
  const p = await bootWith(dir, { inject: { mode: 'full', sessionDirs: [HOME] } })
  const agent = mount(p, { id: 's-alien', cwd: ELSEWHERE })
  assert.equal(agent._registered.length, 0)
  const row = rowsAt(dir).find((r) => r.session_id === 's-alien')
  assert.equal(row.persona_id, 'self:other', '旧行保持原样')
})

test('D5 真子智能体先拒（origin/depth）；parentSession fork 按她的会话走', async () => {
  const dir = tmpDir()
  seedDb(dir).db.close()
  const p = await bootWith(dir, { inject: { mode: 'full', sessionDirs: [HOME] } })
  const a1 = mount(p, { id: 's-sub-origin', cwd: HOME, header: { origin: 'subagent' } })
  const a3 = mount(p, { id: 's-sub-depth', cwd: HOME, header: { delegationDepth: 2 } })
  assert.equal(a1._registered.length + a3._registered.length, 0, '真子智能体不注入')
  const fork = mount(p, { id: 's-fork', cwd: HOME, header: { parentSession: 'parent-x', isSeeded: true, agentPreset: 'standard' } })
  assert.equal(fork._registered.length, 5, 'fork 应注入（含 dy-relationship）')
  const rows = rowsAt(dir)
  assert.equal(rows.some((r) => r.session_id === 's-sub-origin'), false, '真子智能体不写绑定')
  assert.equal(rows.some((r) => r.session_id === 's-sub-depth'), false)
  assert.equal(rows.some((r) => r.session_id === 's-fork'), true, 'fork 写绑定（正常会话）')
})

test('D6 群聊先拒：cwd 在 bind 前缀下也不注入、不写绑定', async () => {
  const dir = tmpDir()
  seedDb(dir).db.close()
  const p = await bootWith(dir, { inject: { mode: 'full', sessionDirs: ['/tmp/fixture-qq'] } })
  const agent = mount(p, { id: 's-group', cwd: '/tmp/fixture-qq/群_123456' })
  assert.equal(agent._registered.length, 0)
  assert.equal(rowsAt(dir).length, 0)
})

test('D7 bind.enabled=false：不写绑定、不读绑定，完全走旧 cwd 白名单', async () => {
  const dir = tmpDir()
  const { db, self } = seedDb(dir)
  bindSession(db, { sessionId: 's-ignored', personaId: self.id, role: 'persona', cwd: ELSEWHERE, source: 'default', now: 10 })
  db.close()
  const p = await bootWith(dir, {
    inject: { mode: 'full', sessionDirs: [HOME] },
    bind: { enabled: false },
  })
  const inHome = mount(p, { id: 's-home', cwd: HOME })
  assert.equal(inHome._registered.length, 4, '旧白名单仍注入')
  const outside = mount(p, { id: 's-ignored', cwd: ELSEWHERE })
  assert.equal(outside._registered.length, 0, 'binding 被忽略')
  const rows = rowsAt(dir)
  assert.equal(rows.length, 1, '关闭后不再写入新绑定')
  assert.equal(rows[0].session_id, 's-ignored', '预置行保留')
})

test('D8 旧 work 行不被删、不被改', async () => {
  const dir = tmpDir()
  const { db } = seedDb(dir)
  db.prepare("INSERT INTO session_bindings(session_id,persona_id,role,cwd,source,created_at) VALUES('old-work','self:1d','work','/sdcard/DCIM/DHSA','subagent',111)").run()
  db.close()
  const p = await bootWith(dir, { inject: { mode: 'full', sessionDirs: [HOME] } })
  mount(p, { id: 's-new', cwd: HOME })
  const old = rowsAt(dir).find((r) => r.session_id === 'old-work')
  assert.deepEqual(
    { persona_id: old.persona_id, role: old.role, cwd: old.cwd, source: old.source, created_at: old.created_at },
    { persona_id: 'self:1d', role: 'work', cwd: '/sdcard/DCIM/DHSA', source: 'subagent', created_at: 111 },
  )
})

test('D9 emotion.why 不受 binding 影响：陌生人会话仍 E_PERMISSION', async () => {
  const dir = tmpDir()
  const { db, self } = seedDb(dir)
  bindSession(db, { sessionId: 's-stranger', personaId: self.id, role: 'persona', cwd: ELSEWHERE, source: 'default', now: 10 })
  db.close()
  const p = await bootWith(dir, { inject: { mode: 'full', sessionDirs: [HOME] } })
  assert.throws(
    () => p.service.emotion.why(6, { header: { id: 's-stranger', cwd: ELSEWHERE } }),
    /E_PERMISSION/,
    'binding 不能把陌生会话变 owner',
  )
  const owner = p.service.emotion.why(6, { header: { id: 's-owner', cwd: HOME } })
  assert.deepEqual(Object.keys(owner), ['points'], '主人会话仍可读')
})

test('D10 表不存在时降级：不抛，回退旧 cwd 白名单', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const db = openDb(join(dir, 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  // 故意不建 session_bindings
  const cfg = loadConfig({ dataDir: dir, personaPath, inject: { mode: 'full', sessionDirs: [HOME] } })
  const injector = createInjector({ cfg, log: console, state: { db, self, emotionLine: () => '' } })
  const agent = makeAgent({ id: 's-no-table', cwd: HOME })
  const r = injector.mount(agent)
  assert.equal(r.mounted, true, '没有绑定表也要能按旧白名单注入')
  assert.equal(agent._registered.length, 4)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='session_bindings'").get().c, 0)
  db.close()
})

test('D11 binding 命中且全局 brief：按 brief 注入', async () => {
  const dir = tmpDir()
  const { db, self } = seedDb(dir)
  bindSession(db, { sessionId: 's-brief', personaId: self.id, role: 'persona', cwd: ELSEWHERE, source: 'default', now: 10 })
  db.close()
  const p = await bootWith(dir, { inject: { mode: 'brief', sessionDirs: [] } })
  const agent = mount(p, { id: 's-brief', cwd: ELSEWHERE })
  const persona = agent._registered.find((r) => r.name === 'dy-persona')
  assert.ok(persona, 'binding 命中应注入')
  assert.match(persona.text(), /^【人格核心·要点】/)
})

test('D12 重复 agent/created 只写一次；不同 session 各一行', async () => {
  const dir = tmpDir()
  seedDb(dir).db.close()
  const p = await bootWith(dir, { inject: { mode: 'full', sessionDirs: [HOME] } })
  const a1 = mount(p, { id: 's-dup', cwd: HOME })
  p.ctx.emit('agent/created', { agent: a1 }) // 同一 agent 再挂一次
  mount(p, { id: 's-dup2', cwd: HOME })
  p.ctx.emit('agent/disposed', { agent: a1 }) // 会话结束不删绑定（留档）
  const rows = rowsAt(dir)
  assert.equal(rows.filter((r) => r.session_id === 's-dup').length, 1, 'disposed 后绑定仍保留')
  assert.equal(rows.filter((r) => r.session_id === 's-dup2').length, 1)
})

test('D13 bind.cwdPrefixes 可单独覆盖 sessionDirs：只按 bind 前缀写', async () => {
  const dir = tmpDir()
  seedDb(dir).db.close()
  const p = await bootWith(dir, {
    inject: { mode: 'full', sessionDirs: [HOME] },
    bind: { enabled: true, cwdPrefixes: ['/tmp/fixture-bindonly'] },
  })
  mount(p, { id: 's-bindonly', cwd: '/tmp/fixture-bindonly/x' })
  mount(p, { id: 's-sessiondir', cwd: HOME })
  const rows = rowsAt(dir)
  assert.ok(rows.some((r) => r.session_id === 's-bindonly'), 'bind 前缀命中应写')
  assert.equal(rows.some((r) => r.session_id === 's-sessiondir'), false, '不在 bind 前缀的 sessionDirs 不写')
})
