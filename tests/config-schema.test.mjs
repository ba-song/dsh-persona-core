/** Config 声明：设置页 3 个 volatile 字段 + volatile 引用在 loadConfig 入口还原。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../lib/index.js'
import { loadConfig, unwrapVolatile } from '../lib/config.js'

test('Config 空配置解析出 DEFAULTS（inject.mode 默认 full / 情绪默认不接管）', () => {
  const cfg = Config({})
  assert.equal(cfg.inject.mode.get(), 'full')
  assert.equal(cfg.emotion.ingestEnabled.get(), false)
  assert.equal(cfg.emotion.threshold.get(), 0.35)
})

test('Config 接受 profile 片段，未知键原样保留', () => {
  const profile = {
    dataDir: '/sdcard/DSHA/人格/数据',
    inject: { mode: 'full', appendHint: true, sessionDirs: ['/sdcard/DSHA/渠道'] },
    emotion: { ingestEnabled: true, threshold: 0.35 },
  }
  const cfg = Config(profile)
  assert.equal(cfg.inject.mode.get(), 'full')
  assert.equal(cfg.emotion.ingestEnabled.get(), true)
  assert.equal(cfg.emotion.threshold.get(), 0.35)
  // 未声明的键（不含 volatile）不能被 schema 丢掉
  assert.equal(cfg.dataDir, profile.dataDir)
  assert.deepEqual(cfg.inject.sessionDirs, profile.inject.sessionDirs)
  assert.equal(cfg.inject.appendHint, true)
})

test('Config 的 mode 只接受 full/brief/off', () => {
  for (const mode of ['full', 'brief', 'off']) {
    assert.equal(Config({ inject: { mode } }).inject.mode.get(), mode)
  }
  assert.throws(() => Config({ inject: { mode: 'FULLL' } }), /expected/)
})

test('Config 的 threshold 限制在 0..1', () => {
  assert.equal(Config({ emotion: { threshold: 0 } }).emotion.threshold.get(), 0)
  assert.equal(Config({ emotion: { threshold: 1 } }).emotion.threshold.get(), 1)
  assert.throws(() => Config({ emotion: { threshold: 1.5 } }), /<= 1/)
  assert.throws(() => Config({ emotion: { threshold: -0.1 } }), />= 0/)
})

test('loadConfig 入口先还原 volatile 引用', () => {
  const cfg = loadConfig({
    inject: { mode: { get: () => 'brief' } },
    emotion: { threshold: { get: () => 0.5 } },
  })
  assert.equal(cfg.inject.mode, 'brief')
  assert.equal(cfg.emotion.threshold, 0.5)
})

test('loadConfig 直接吃 Config 解析结果（volatile 引用不丢配置）', () => {
  const resolved = Config({
    inject: { mode: 'brief' },
    emotion: { ingestEnabled: true, threshold: 0.5 },
  })
  const cfg = loadConfig(resolved)
  assert.equal(cfg.inject.mode, 'brief')
  assert.equal(cfg.emotion.ingestEnabled, true)
  assert.equal(cfg.emotion.threshold, 0.5)
})

test('loadConfig 直接吃空对象时，运行时默认仍是安全起步 off', () => {
  const cfg = loadConfig({})
  assert.equal(cfg.inject.mode, 'off')
  assert.equal(cfg.emotion.ingestEnabled, false)
  assert.equal(cfg.emotion.threshold, 0.35)
})

test('unwrapVolatile 对普通配置零影响', () => {
  const raw = { inject: { mode: 'full', sessionDirs: ['/a'] }, emotion: { threshold: 0.4 } }
  const out = unwrapVolatile(raw)
  assert.deepEqual(out, raw)
  assert.notEqual(out, raw)
})
