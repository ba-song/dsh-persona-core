/** 注入：默认 off、白名单、子智能体/群聊跳过、重复挂载、双 context、空人格。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { bootPlugin, makeAgent, tmpDir, writeFixturePersona, FIXTURE_PERSONA } from './helpers/fixtures.mjs'
import { loadConfig } from '../lib/config.js'
import { createInjector } from '../lib/inject.js'

const OWNER_DIR = '/tmp/fixture-owner-private'
const cfgRaw = { inject: { mode: 'full', sessionDirs: [{ dir: OWNER_DIR, mode: 'full' }] } }

function agentAt(id, cwd, header = {}) {
  return makeAgent({ id, cwd, header })
}

test('阶段 2 默认：mode=off、白名单空 → 不挂任何 context', async () => {
  const { ctx } = await bootPlugin({})
  const agent = agentAt('sess-1', OWNER_DIR)
  ctx.emit('agent/created', { agent })
  assert.equal(agent._registered.length, 0)
})

test('N2 白名单内私聊 + full：挂 dy-persona(900) 与 dy-emotion(910)，都不设 required', async () => {
  const { ctx } = await bootPlugin({ cfg: cfgRaw })
  const agent = agentAt('sess-2', OWNER_DIR)
  ctx.emit('agent/created', { agent })
  const names = agent._registered.map((r) => r.name).sort()
  // 2026-11-16：新增 dy-relationship(913)，恒定输出关系底色（不设阈值门控）
  assert.deepEqual(names, ['dy-emotion', 'dy-emotion-act', 'dy-persona', 'dy-relationship', 'dy-voice'])
  const personaCtx = agent._registered.find((r) => r.name === 'dy-persona')
  const emotionCtx = agent._registered.find((r) => r.name === 'dy-emotion')
  assert.equal(personaCtx.order, 900)
  assert.equal(emotionCtx.order, 910)
  assert.equal(personaCtx.required, undefined, '不得设 required')
  assert.equal(emotionCtx.required, undefined, '不得设 required')
  assert.match(personaCtx.text(), /^【人格核心】/)
})

test('F7 真子智能体（origin/delegationDepth）不挂；仅 parentSession 的 GUI fork 视为她的会话', async () => {
  const { ctx } = await bootPlugin({ cfg: cfgRaw })
  for (const header of [{ origin: 'subagent' }, { delegationDepth: 1 }]) {
    const agent = agentAt(`sess-sub-${JSON.stringify(header)}`, OWNER_DIR, header)
    ctx.emit('agent/created', { agent })
    assert.equal(agent._registered.length, 0, `header=${JSON.stringify(header)} 不应挂载`)
  }
  // 宿主 fork：parentSession + isSeeded + 普通 agentPreset，无 origin/depth
  const fork = agentAt('sess-fork', OWNER_DIR, { parentSession: 'p', isSeeded: true, agentPreset: 'standard' })
  ctx.emit('agent/created', { agent: fork })
  assert.equal(fork._registered.length, 5, 'fork 应按她的正常会话注入（含 dy-relationship）')
})

test('F9 群聊目录不挂（即使在白名单前缀里）', async () => {
  const { ctx } = await bootPlugin({ cfg: { inject: { mode: 'full', sessionDirs: ['/tmp'] } } })
  const agent = agentAt('sess-group', '/tmp/群_0000000')
  ctx.emit('agent/created', { agent })
  assert.equal(agent._registered.length, 0)
})

test('F8 白名单外不挂', async () => {
  const { ctx } = await bootPlugin({ cfg: cfgRaw })
  const agent = agentAt('sess-out', '/tmp/somewhere-else')
  ctx.emit('agent/created', { agent })
  assert.equal(agent._registered.length, 0)
})

test('F4 同一会话重复 created 只挂一次；disposed 后清理', async () => {
  const { ctx } = await bootPlugin({ cfg: cfgRaw })
  const agent = agentAt('sess-dup', OWNER_DIR)
  ctx.emit('agent/created', { agent })
  ctx.emit('agent/created', { agent })
  assert.equal(agent._registered.length, 5, 'context（persona/emotion/emotion-act/relationship/voice），不重复注册')
  ctx.emit('agent/disposed', { agent })
  assert.equal(agent._registered.length, 0, 'disposed 后应卸载')
})

test('F3 人格文件为空 → 不挂载（empty-persona）', async () => {
  const dir = tmpDir()
  const personaPath = join(dir, 'persona.md')
  writeFileSync(personaPath, '   \n', 'utf8')
  const { ctx } = await bootPlugin({ cfg: { ...cfgRaw, personaPath } })
  const agent = agentAt('sess-empty', OWNER_DIR)
  ctx.emit('agent/created', { agent })
  assert.equal(agent._registered.length, 0)
})

test('brief 档注入要点而非全文', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir, FIXTURE_PERSONA)
  const { ctx } = await bootPlugin({
    cfg: { ...cfgRaw, personaPath, inject: { mode: 'brief', sessionDirs: [{ dir: OWNER_DIR, mode: 'brief' }] } },
  })
  const agent = agentAt('sess-brief', OWNER_DIR)
  ctx.emit('agent/created', { agent })
  const personaCtx = agent._registered.find((r) => r.name === 'dy-persona')
  assert.match(personaCtx.text(), /^【人格核心·要点】/)
  assert.ok(personaCtx.text().length < 400)
})

test('F13 情绪文本稳定：同一 label 下两次求值完全一致', async () => {
  const { ctx, service } = await bootPlugin({ cfg: cfgRaw })
  const agent = agentAt('sess-stable', OWNER_DIR)
  ctx.emit('agent/created', { agent })
  const emotionCtx = agent._registered.find((r) => r.name === 'dy-emotion')
  const a = emotionCtx.text()
  const b = emotionCtx.text()
  assert.equal(a, b)
  // 情绪未达阈值时为空串（≤60 字、无数字）
  if (a) {
    assert.ok(a.length <= 60)
    assert.doesNotMatch(a, /\d/)
  }
  assert.equal(typeof service.emotion.state().label, 'string')
})

test('resolveScope 单元：最长前缀 + 显式 off 覆盖', () => {
  const cfg = loadConfig({
    inject: {
      mode: 'full',
      sessionDirs: [
        { dir: '/a/private', mode: 'full' },
        { dir: '/a', mode: 'off' },
        { dir: '/a/private/special', mode: 'brief' },
      ],
    },
  })
  const injector = createInjector({ cfg, log: console, state: { self: { display_name: '汐' } } })
  let n = 0
  const hit = (cwd) => {
    n += 1
    const agent = agentAt(`scope-${n}`, cwd)
    return injector.mount(agent)
  }
  assert.equal(hit('/a/private').mode, 'full')
  assert.equal(hit('/a/private/special').mode, 'brief', '更长前缀优先')
  assert.equal(hit('/a/other').mounted, false, '显式 off 前缀')
  assert.equal(hit('/zzz').mounted, false, '白名单外')
})
