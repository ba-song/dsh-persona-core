/**
 * 2026-11-16 修：profile 里写 true 的 4 个开关被 config.js 硬编码成 false（"配了等于没配"）。
 * 这一组测试把两件事钉死：
 *   1) loadConfig 必须尊重显式传入的 styleHint / worldRules / virtue.enabled / grievance.*；
 *   2) grievance.enabled=true 时，连续 3 次短回复**真的**写进 grievances 表
 *      —— 原来 index.js 调 openGrievance 却没 import，ReferenceError 被 catch{} 吞掉，
 *         账本永远 0 行。只修配置不修 import，等于把静默失败换个位置。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { loadConfig } from '../lib/config.js'
import { bootPlugin, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const OWNER = '/tmp/fixture-owner-private'

test('C1 默认值不变：不传就是关（安全起步不能被破坏）', () => {
  const cfg = loadConfig({})
  assert.equal(cfg.inject.styleHint, false)
  assert.equal(cfg.inject.worldRules, false)
  assert.equal(cfg.virtue.enabled, false)
  assert.equal(cfg.grievance.enabled, false)
  assert.equal(cfg.inject.stylePath, '/sdcard/DSHA/记忆/数据/style.json')
  // 关系块默认开（这是新增层，见 lib/relationship.js）
  assert.equal(cfg.inject.relationship, true)
})

test('C2 显式 true 必须生效（profile 写 true 就该是 true）', () => {
  const cfg = loadConfig({
    inject: { styleHint: true, worldRules: true, stylePath: '/tmp/x-style.json' },
    virtue: { enabled: true },
    grievance: { enabled: true, autoOnShortStreak: false, severity: 0.7 },
  })
  assert.equal(cfg.inject.styleHint, true)
  assert.equal(cfg.inject.worldRules, true)
  assert.equal(cfg.inject.stylePath, '/tmp/x-style.json')
  assert.equal(cfg.virtue.enabled, true)
  assert.equal(cfg.grievance.enabled, true)
  assert.equal(cfg.grievance.autoOnShortStreak, false)
  assert.equal(cfg.grievance.severity, 0.7)
})

test('C3 grievance.enabled=true → 第 3 次短回复真的落一行（证明 openGrievance 已 import）', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const { ctx } = await bootPlugin({
    cfg: {
      personaPath,
      emotion: { ingestEnabled: true },
      grievance: { enabled: true },
      inject: { mode: 'full', sessionDirs: [{ dir: OWNER, mode: 'full' }] },
    },
  })
  const session = { header: { id: 'sess-grievance', cwd: OWNER } }
  const userMsg = (text, seq) => ({
    type: 'user/message',
    seq,
    time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })

  const db = new DatabaseSync(join(dir, 'persona.db'), { readOnly: true })
  const count = () => Number(db.prepare('SELECT count(*) c FROM grievances').get().c)

  ctx.emit('session/event', session, userMsg('嗯', 1))
  ctx.emit('session/event', session, userMsg('哦', 2))
  assert.equal(count(), 0, '只回两次短句不该记账（阈值是第 3 次）')
  ctx.emit('session/event', session, userMsg('好', 3))
  assert.equal(count(), 1, '第 3 次短回复必须落一行；为 0 说明 openGrievance 仍未被调用')
  db.close()
})

test('C4 grievance.enabled=false（默认）时，短回复不落账', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const { ctx } = await bootPlugin({
    cfg: {
      personaPath,
      emotion: { ingestEnabled: true },
      inject: { mode: 'full', sessionDirs: [{ dir: OWNER, mode: 'full' }] },
    },
  })
  const session = { header: { id: 'sess-grievance-off', cwd: OWNER } }
  const userMsg = (text, seq) => ({
    type: 'user/message',
    seq,
    time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
  for (let i = 1; i <= 3; i += 1) ctx.emit('session/event', session, userMsg('嗯', i))
  const db = new DatabaseSync(join(dir, 'persona.db'), { readOnly: true })
  assert.equal(Number(db.prepare('SELECT count(*) c FROM grievances').get().c), 0)
  db.close()
})
