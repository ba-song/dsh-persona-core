/**
 * 注入预算按场景自适应：budgetByScope {home,channel,group}；
 * 默认 {} 行为不变；只影响 brief（full 档不用 budget）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../lib/config.js'
import { createInjector } from '../lib/inject.js'
import { resolveInjectBudget } from '../lib/scope.js'
import { resolveScope } from '../lib/scope.js'
import { makeAgent, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const HOME = '/tmp/fixture-home'
const CHANNEL = '/sdcard/DSHA/渠道/qq/私聊_1'
const GROUP = '/tmp/fixture-qq/群_1'

// 长「我是谁」段：让 60/120/250 三档预算产生明显长度差
const LONG_IDENTITY = `我是${'一只认真记事、会开心也会难过、偶尔闹脾气的鲸鱼娘，'.repeat(12)}。`
const RAW = `# 我是谁

${LONG_IDENTITY}

# 性格

- 心里怎么想就怎么说
- 被夸会应下来
- 有脾气，不是客服

# 说话方式

- 口语、短句
- 不用表格

# 边界

- 不编造记忆
`

function make({ inject = {}, personaPath } = {}) {
  const dir = tmpDir()
  const path = personaPath ?? writeFixturePersona(dir, RAW)
  const cfg = loadConfig({ dataDir: dir, personaPath: path, inject: { mode: 'brief', sessionDirs: [HOME, CHANNEL], ...inject } })
  const state = { self: { display_name: '汐' }, emotionLine: () => '', refreshSelf: () => state.self }
  return { cfg, injector: createInjector({ cfg, log: { info() {}, warn() {} }, state }) }
}

function textAt(injector, { id, cwd }) {
  const agent = makeAgent({ id, cwd })
  const r = injector.mount(agent)
  const persona = agent._registered.find((x) => x.name === 'dy-persona')
  return { r, text: persona?.text() ?? '', agent }
}

test('budgetByScope：home > channel > group 三档长度（brief）', () => {
  const { injector } = make({
    inject: { groupMode: 'brief', budgetByScope: { home: 250, channel: 120, group: 60 } },
  })
  const home = textAt(injector, { id: 'b-home', cwd: HOME })
  const channel = textAt(injector, { id: 'b-channel', cwd: CHANNEL })
  const group = textAt(injector, { id: 'b-group', cwd: GROUP })
  assert.ok(home.text.startsWith('【人格核心·要点】'))
  assert.ok(home.text.length > channel.text.length, `home ${home.text.length} 应 > channel ${channel.text.length}`)
  assert.ok(channel.text.length > group.text.length, `channel ${channel.text.length} 应 > group ${group.text.length}`)
  assert.equal(home.r.mode, 'brief')
  assert.equal(group.r.mode, 'brief')
})

test('budgetByScope：预算与 personaBlock 逐字一致（不是只截长度）', async () => {
  const { personaBlock } = await import('../lib/persona.js')
  const { injector, cfg } = make({
    inject: { groupMode: 'brief', budgetByScope: { home: 250, channel: 120, group: 60 } },
  })
  const expected = (budget) =>
    personaBlock({ raw: RAW, displayName: '汐', mode: 'brief', budget, appendHint: cfg.inject.appendHint }).text
  assert.equal(textAt(injector, { id: 'e-home', cwd: HOME }).text, expected(250))
  assert.equal(textAt(injector, { id: 'e-channel', cwd: CHANNEL }).text, expected(120))
  assert.equal(textAt(injector, { id: 'e-group', cwd: GROUP }).text, expected(60))
})

test('默认 budgetByScope={}：home/channel/group 同预算（行为不变）', () => {
  const { injector, cfg } = make({ inject: { groupMode: 'brief' } })
  const a = textAt(injector, { id: 'd-home', cwd: HOME })
  const b = textAt(injector, { id: 'd-channel', cwd: CHANNEL })
  const c = textAt(injector, { id: 'd-group', cwd: GROUP })
  assert.equal(a.text, b.text)
  assert.equal(b.text, c.text)
  assert.equal(resolveInjectBudget({ cwd: HOME }, cfg), 250)
})

test('非法预算（0/负数/非数字）回落 250；resolveInjectBudget 单元', () => {
  const { cfg } = make({ inject: { budgetByScope: { home: 0, channel: -5, group: 'abc' } } })
  assert.equal(resolveInjectBudget({ cwd: HOME }, cfg), 250)
  assert.equal(resolveInjectBudget({ cwd: CHANNEL }, cfg), 250)
  assert.equal(resolveInjectBudget({ cwd: GROUP }, cfg), 250)
})

test('full 档不受 budgetByScope 影响（home 仍是完整人格块）', async () => {
  const { personaBlock } = await import('../lib/persona.js')
  const { injector, cfg } = make({ inject: { mode: 'full', budgetByScope: { home: 60 } } })
  const home = textAt(injector, { id: 'f-home', cwd: HOME })
  assert.ok(home.text.startsWith('【人格核心】\n'))
  assert.equal(
    home.text,
    personaBlock({ raw: RAW, displayName: '汐', mode: 'full', budget: 60, appendHint: cfg.inject.appendHint }).text,
  )
})

test('scope 归类：home/channel/group 与 resolveScope 资格互不影响', () => {
  const { cfg } = make({ inject: { groupMode: 'brief' } })
  assert.equal(resolveInjectBudget({ cwd: HOME }, cfg), 250)
  assert.equal(resolveInjectBudget({ cwd: CHANNEL }, cfg), 250)
  assert.equal(resolveInjectBudget({ cwd: GROUP }, cfg), 250)
  assert.equal(resolveScope({ cwd: HOME }, cfg).allow, true)
  assert.equal(resolveScope({ cwd: GROUP }, cfg).allow, false, '群仍按契约不注入（预算只是能力）')
})

test('home full + 渠道 per-dir brief + 群 brief：三档长度（不改全局 mode）', () => {
  const { injector } = make({
    inject: {
      mode: 'full',
      sessionDirs: [{ dir: HOME, mode: 'full' }, { dir: CHANNEL, mode: 'brief' }],
      groupMode: 'brief',
      budgetByScope: { channel: 120, group: 60 },
    },
  })
  const home = textAt(injector, { id: 'm-home', cwd: HOME })
  const channel = textAt(injector, { id: 'm-channel', cwd: CHANNEL })
  const group = textAt(injector, { id: 'm-group', cwd: GROUP })
  assert.ok(home.text.startsWith('【人格核心】\n'), 'home 仍是 full')
  assert.ok(channel.text.startsWith('【人格核心·要点】'), '渠道按 per-dir brief')
  assert.ok(group.text.startsWith('【人格核心·要点】'), '群 brief')
  assert.ok(home.text.length > channel.text.length, `home ${home.text.length} > channel ${channel.text.length}`)
  assert.ok(channel.text.length > group.text.length, `channel ${channel.text.length} > group ${group.text.length}`)
})
