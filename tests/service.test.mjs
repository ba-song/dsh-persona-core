/** dyPersona 服务：契约 v1.1 形状、判空降级、权限（含无 header 拒绝）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { E } from '../lib/db.js'
import { bootPlugin, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const OWNER_DIR = '/tmp/fixture-owner-private'
const cfgBase = {
  inject: { mode: 'full', sessionDirs: [{ dir: OWNER_DIR, mode: 'full' }] },
}
const ownerHeader = { id: 'sess-owner', cwd: OWNER_DIR }

test('N5 服务可 provide、可 get，字段类型符合契约', async () => {
  const { ctx, service } = await bootPlugin({ cfg: cfgBase })
  assert.ok(service, 'dyPersona 应已 provide')
  assert.equal(ctx.get('dyPersona'), service)
  assert.match(service.selfId(), /^self:/)
  assert.equal(typeof service.displayName(), 'string')
  assert.equal(typeof service.personaText(), 'string')
  assert.equal(typeof service.voice(), 'string')
  assert.ok(service.voice().length <= 120)
  const block = service.block()
  assert.deepEqual(Object.keys(block).sort(), ['mode', 'text'])
  const version = service.version()
  assert.deepEqual(Object.keys(version).sort(), ['hash', 'nameVersion', 'personaVersion'])
  assert.equal(typeof version.personaVersion, 'number')
})

test('emotion.state 形状 + 中性值；DB 关闭后 degraded:true 不抛', async () => {
  const { service, ctx } = await bootPlugin({ cfg: cfgBase })
  const state = service.emotion.state()
  for (const key of ['valence', 'arousal', 'certainty', 'label', 'intensity', 'updatedAt']) {
    assert.ok(key in state, `缺字段 ${key}`)
  }
  assert.equal(state.degraded, undefined)
  // 模拟 DB 不可用：把内部连接置空（服务不抛，返回中性 + degraded）
  const mod = await import('../lib/service.js')
  const broken = mod.createPersonaService({ db: () => null, cfg: { personaPath: join(tmpDir(), 'x.md') }, self: () => null })
  const degraded = broken.emotion.state()
  assert.equal(degraded.degraded, true)
  assert.equal(degraded.label, '平静')
  void ctx
})

test('emotion.toneHint ≤40 字且不含数字', async () => {
  const { service } = await bootPlugin({ cfg: cfgBase })
  const hint = service.emotion.toneHint()
  assert.ok(hint.length <= 40, `toneHint 长度 ${hint.length}`)
  assert.doesNotMatch(hint, /\d/)
})

test('emotion.why 无 header → E_PERMISSION（v1.1 新增）', async () => {
  const { service } = await bootPlugin({ cfg: cfgBase })
  assert.throws(() => service.emotion.why(6), (err) => err.code === E.PERMISSION)
  assert.throws(() => service.emotion.why(6, {}), (err) => err.code === E.PERMISSION)
  assert.throws(() => service.emotion.why(6, { includeTrigger: true }), (err) => err.code === E.PERMISSION)
})

test('emotion.why 子智能体 header → E_PERMISSION', async () => {
  const { service } = await bootPlugin({ cfg: cfgBase })
  const header = { ...ownerHeader, parentSession: 'sess-parent' }
  assert.throws(() => service.emotion.why(6, { header }), (err) => err.code === E.PERMISSION)
  const header2 = { ...ownerHeader, origin: 'subagent' }
  assert.throws(() => service.emotion.why(6, { header: header2 }), (err) => err.code === E.PERMISSION)
  const header3 = { ...ownerHeader, delegationDepth: 2 }
  assert.throws(() => service.emotion.why(6, { header: header3 }), (err) => err.code === E.PERMISSION)
})

test('emotion.why 群聊/白名单外 → E_PERMISSION；白名单内 → 返回 points', async () => {
  const { service } = await bootPlugin({ cfg: cfgBase })
  assert.throws(() => service.emotion.why(6, { header: { id: 's', cwd: '/tmp/群_123' } }), (err) => err.code === E.PERMISSION)
  assert.throws(() => service.emotion.why(6, { header: { id: 's', cwd: '/tmp/other' } }), (err) => err.code === E.PERMISSION)
  const out = service.emotion.why(6, { header: ownerHeader })
  assert.deepEqual(Object.keys(out), ['points'])
  assert.ok(Array.isArray(out.points))
})

test('emotion.why 非法 hours → E_INVALID_ARG', async () => {
  const { service } = await bootPlugin({ cfg: cfgBase })
  assert.throws(() => service.emotion.why(0, { header: ownerHeader }), (err) => err.code === E.INVALID_ARG)
  assert.throws(() => service.emotion.why(-1, { header: ownerHeader }), (err) => err.code === E.INVALID_ARG)
  assert.throws(() => service.emotion.why(9999, { header: ownerHeader }), (err) => err.code === E.INVALID_ARG)
})

test('默认配置：注入 off、白名单空（阶段 2 安全起步）', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const { service, ctx } = await bootPlugin({ cfg: { personaPath } })
  assert.equal(service.block().mode, 'off')
  assert.equal(service.block().text, '')
  assert.equal(ctx.get('dyPersona'), service)
  assert.equal(service.emotion.state().label, '平静')
})

test('block() 在 full 档给出人格核心文本；off 档为空', async () => {
  const { service } = await bootPlugin({ cfg: cfgBase })
  const full = service.block()
  assert.equal(full.mode, 'full')
  assert.match(full.text, /^【人格核心】/)
  assert.ok(full.text.length > 20)
})

test('工具可注册且 whoami 返回契约字段', async () => {
  const { tools } = await bootPlugin({ cfg: cfgBase })
  const names = tools.list().map((t) => t.name).sort()
  for (const need of [
    'dy_persona_whoami',
    'dy_persona_rename',
    'dy_persona_get',
    'dy_persona_history',
    'dy_emotion_state',
    'dy_emotion_timeline',
    'dy_emotion_points',
    'dy_emotion_why',
  ]) {
    assert.ok(names.includes(need), `缺工具 ${need}`)
  }
  const who = await tools.get('dy_persona_whoami').execute({}, {})
  const detail = JSON.parse(who.detail)
  assert.match(detail.self_id, /^self:/)
  assert.equal(typeof detail.persona_version, 'number')
  assert.equal(typeof detail.name_version, 'number')
})
