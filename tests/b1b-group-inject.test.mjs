/**
 * 批次 B1b：群聊注入能力（默认 off；brief 时只给 brief+情绪；同群 60s 限一次）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../lib/config.js'
import { createInjector } from '../lib/inject.js'
import { makeAgent, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const OWNER = '/tmp/fixture-owner-private'
const GROUP = '/tmp/fixture-qq/群_123456'

function make(groupMode, { now = () => 0 } = {}) {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const cfg = loadConfig({
    dataDir: dir,
    personaPath,
    inject: { mode: 'full', sessionDirs: [{ dir: OWNER, mode: 'full' }], groupMode },
  })
  const log = { info() {}, warn() {} }
  const state = { self: { display_name: '汐' }, emotionLine: () => '', refreshSelf: () => state.self }
  return { injector: createInjector({ cfg, log, state, now }), cfg }
}

function mount(injector, { id, cwd, header = {} }) {
  const agent = makeAgent({ id, cwd, header })
  return { agent, result: injector.mount(agent) }
}

test('B1b-默认 off：群聊仍拒（回归）', () => {
  const { injector } = make(undefined)
  const { agent, result } = mount(injector, { id: 'g-off', cwd: GROUP })
  assert.equal(result.mounted, false)
  assert.equal(result.reason, 'group')
  assert.equal(agent._registered.length, 0)
})

test('B1b-非法 groupMode 回落 off', () => {
  const { cfg, injector } = make('full')
  assert.equal(cfg.inject.groupMode, 'off')
  const { result } = mount(injector, { id: 'g-bad', cwd: GROUP })
  assert.equal(result.mounted, false)
})

test('B1b-brief：群聊只挂 brief 档 + 情绪行，不给完整人格', () => {
  const { injector } = make('brief')
  const { agent, result } = mount(injector, { id: 'g-brief', cwd: GROUP })
  assert.equal(result.mounted, true)
  assert.equal(result.mode, 'brief')
  assert.equal(agent._registered.length, 3)
  const persona = agent._registered.find((r) => r.name === 'dy-persona')
  assert.match(persona.text(), /^【人格核心·要点】/)
  assert.equal(persona.text().includes('【人格核心】\n'), false, '不得给完整档')
  const emotion = agent._registered.find((r) => r.name === 'dy-emotion')
  assert.ok(emotion, '情绪行仍要挂')
})

test('B1b-同群 60s 限幅：第二次拒，超时后可再挂', () => {
  let t = 1_000_000
  const { injector } = make('brief', { now: () => t })
  const first = mount(injector, { id: 'g-1', cwd: GROUP })
  assert.equal(first.result.mounted, true)
  assert.equal(first.result.reason, 'group-brief')

  t += 59_000
  const second = mount(injector, { id: 'g-2', cwd: GROUP })
  assert.equal(second.result.mounted, false)
  assert.equal(second.result.reason, 'group-throttled')
  assert.equal(second.agent._registered.length, 0)

  t += 1_001 // 累计 60.001s
  const third = mount(injector, { id: 'g-3', cwd: GROUP })
  assert.equal(third.result.mounted, true)
})

test('B1b-限幅按群（cwd）隔离：不同群互不影响', () => {
  const { injector } = make('brief')
  assert.equal(mount(injector, { id: 'ga', cwd: GROUP }).result.mounted, true)
  assert.equal(mount(injector, { id: 'gb', cwd: '/tmp/fixture-qq/群_999' }).result.mounted, true)
})

test('B1b-私聊不受 groupMode 影响：仍按 full', () => {
  const { injector } = make('brief')
  const { agent, result } = mount(injector, { id: 'p-1', cwd: OWNER })
  assert.equal(result.mounted, true)
  const persona = agent._registered.find((r) => r.name === 'dy-persona')
  assert.match(persona.text(), /^【人格核心】\n/)
  assert.equal(result.mode, 'full')
})
