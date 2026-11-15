/**
 * 临时止血：主人 user 消息里的疲惫词不改变她的情绪；她自己的 assistant 消息不受影响。
 * 只改情绪打分，不改记忆/原话档案（trigger 仍存原文）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { DEFAULTS, ensureState, ingestEmotion, stripOwnerFatigue } from '../lib/emotion.js'
import { loadConfig } from '../lib/config.js'
import { tmpDir } from './helpers/fixtures.mjs'

function freshDb() {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  return { db, self }
}

function run(text, { self = false, opts = {} } = {}) {
  const { db, self: row } = freshDb()
  const out = ingestEmotion(db, row.id, {
    text,
    msgRef: `explicit:fatigue:${Math.random().toString(16).slice(2)}`,
    at: Date.now(),
    opts: { ...DEFAULTS, ...opts },
    self,
    forceAudit: true,
  })
  const state = db.prepare('select valence,label,intensity from emotion_state where self_id=?').get(row.id)
  const timeline = db.prepare('select count(*) c from emotion_timeline where self_id=?').get(row.id).c
  db.close()
  return { out, state, timeline }
}

test('疲惫词分句剔除：只丢含疲惫词的分句，保留其他分句', () => {
  assert.equal(stripOwnerFatigue('我疲惫又累又困，没力气、撑不住、熬夜、乏'), '')
  assert.equal(stripOwnerFatigue('你困了嘛'), '')
  assert.equal(stripOwnerFatigue('聊到你自己说困为止'), '')
  assert.equal(stripOwnerFatigue('我好难过'), '我好难过')
  assert.equal(stripOwnerFatigue('我好累，但是今天很开心'), '但是今天很开心')
  assert.equal(stripOwnerFatigue('熬夜好晚'), '')
})

test('主人「你困了嘛」：不改变情绪、不写时间线', () => {
  const { out, state, timeline } = run('你困了嘛')
  assert.equal(out.applied, false)
  assert.equal(state.valence, 0)
  assert.equal(state.label, '平静')
  assert.equal(timeline, 0)
})

test('主人「聊到你自己说困为止」：不改变情绪、不写时间线', () => {
  const { out, state, timeline } = run('聊到你自己说困为止')
  assert.equal(out.applied, false)
  assert.equal(state.valence, 0)
  assert.equal(state.label, '平静')
  assert.equal(timeline, 0)
})

test('主人「我好累」及全部疲惫词：都不再产生疲惫', () => {
  for (const text of ['我好累', '我困了', '有点疲惫', '没力气', '撑不住了', '熬夜好晚', '有点乏']) {
    const { out, state, timeline } = run(text)
    assert.equal(out.applied, false, `不应应用：${text}`)
    assert.equal(state.valence, 0, `valence 应为 0：${text}`)
    assert.equal(timeline, 0, `不应写时间线：${text}`)
  }
})

test('只禁疲惫类：主人「我好难过」仍能扣分；混合句保留其他情绪', () => {
  const sad = run('我好难过')
  assert.equal(sad.out.applied, true)
  assert.ok(sad.state.valence < -0.02, `应扣分，实际 ${sad.state.valence}`)

  const mixed = run('我好累，但是今天很开心')
  assert.equal(mixed.out.applied, true)
  assert.ok(mixed.state.valence > 0.05, `疲惫剔除后应按开心加分，实际 ${mixed.state.valence}`)
})

test('她自己的「累」：按 selfWeight 小幅负向，不受主人规则影响', () => {
  const self = run('累', { self: true })
  assert.equal(self.out.applied, true)
  assert.ok(self.state.valence < -0.01, `应小幅负向，实际 ${self.state.valence}`)
  assert.ok(self.state.valence > -0.1, `selfWeight 应小，实际 ${self.state.valence}`)
  assert.equal(self.timeline, 1)
})

test('她自己的「我不累」：仍按否定处理（正向）', () => {
  const self = run('我不累', { self: true })
  assert.equal(self.out.applied, true)
  assert.ok(self.state.valence > 0, `否定后应正向，实际 ${self.state.valence}`)
})

test('关闭 ownerFatigueIgnore：主人「累」恢复旧行为（负向）', () => {
  const { out, state } = run('累', { opts: { ownerFatigueIgnore: false } })
  assert.equal(out.applied, true)
  assert.ok(state.valence < -0.05, `旧行为应扣分，实际 ${state.valence}`)
})

test('配置默认 true；显式 false 才关闭', () => {
  assert.equal(loadConfig({}).emotion.ownerFatigueIgnore, true)
  assert.equal(loadConfig({ emotion: { ownerFatigueIgnore: false } }).emotion.ownerFatigueIgnore, false)
  assert.equal(loadConfig({ emotion: { ownerFatigueIgnore: 'yes' } }).emotion.ownerFatigueIgnore, true)
})
