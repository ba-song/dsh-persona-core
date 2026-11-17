/** 配置与「空人格不写快照」的回归测试（防把数据写到生产路径）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadConfig } from '../lib/config.js'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { bootPlugin, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

test('只给 dataDir 时 dbPath/personaPath 跟随，不回落生产路径', () => {
  const cfg = loadConfig({ dataDir: '/tmp/somewhere' })
  assert.equal(cfg.dbPath, '/tmp/somewhere/persona.db')
  assert.equal(cfg.personaPath, '/tmp/somewhere/persona.md')
})

test('默认配置才指向生产目录（显式默认，不是隐式回落）', () => {
  // 2026-11-04 D-001 迁移后生产路径改为 /sdcard/DSHA/人格/数据；旧路径 /DSH记忆档案/persona 已不存在。
  const cfg = loadConfig({})
  assert.equal(cfg.dbPath, '/sdcard/DSHA/人格/数据/persona.db')
  assert.equal(cfg.personaPath, '/sdcard/DSHA/人格/数据/persona.md')
})

test('默认注入 off、白名单空、情绪不接管', () => {
  const cfg = loadConfig({})
  assert.equal(cfg.inject.mode, 'off')
  assert.deepEqual(cfg.inject.sessionDirs, [])
  assert.equal(cfg.emotion.ingestEnabled, false)
})

test('非法 mode 回落 off（不因拼错打开注入）', () => {
  assert.equal(loadConfig({ inject: { mode: 'FULLL' } }).inject.mode, 'off')
  assert.equal(loadConfig({ inject: { mode: 'brief' } }).inject.mode, 'brief')
})

test('空人格文件：不写 persona_versions、不升 persona_version', async () => {
  const dir = tmpDir()
  const personaPath = join(dir, 'missing.md') // 不存在
  const { service, ctx } = await bootPlugin({ cfg: { personaPath } })
  assert.equal(service.personaText(), '')
  assert.equal(service.block().text, '')
  // 直接看库
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'persona.db'), { readOnly: true })
  assert.equal(db.prepare('SELECT COUNT(*) c FROM persona_versions').get().c, 0)
  const self = db.prepare('SELECT persona_version FROM self').get()
  assert.equal(Number(self.persona_version), 1)
  db.close()
  void ctx
})

test('有内容时写一次快照，重复启动不重复写', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  await bootPlugin({ cfg: { personaPath } })
  await bootPlugin({ cfg: { personaPath } })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'persona.db'), { readOnly: true })
  assert.equal(db.prepare('SELECT COUNT(*) c FROM persona_versions').get().c, 1)
  db.close()
})

test('self 行只有一行 active（重复启动不新增行）', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  await bootPlugin({ cfg: { personaPath } })
  await bootPlugin({ cfg: { personaPath } })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'persona.db'), { readOnly: true })
  assert.equal(db.prepare('SELECT COUNT(*) c FROM self').get().c, 1)
  db.close()
})

test('openDb 幂等：同一路径重复打开不报错', () => {
  const dir = tmpDir()
  const path = join(dir, 'persona.db')
  const a = openDb(path)
  ensureSelf(a, '汐')
  a.close()
  const b = openDb(path)
  assert.equal(ensureSelf(b, '汐').display_name, '汐')
  b.close()
})
