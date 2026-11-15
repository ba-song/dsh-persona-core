/** F14：schema v1 → v2 迁移（幂等）与 v2 全新库形状。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { openDb, migrateToV2, SCHEMA_VERSION } from '../lib/db.js'
import { makeV1Db, tmpDir } from './helpers/fixtures.mjs'

const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name)

test('N1/F14 全新库直接是 v2 形状', () => {
  const dir = tmpDir()
  const db = openDb(join(dir, 'persona.db'))
  for (const [table, need] of Object.entries({
    self: ['id', 'display_name', 'name_version', 'persona_version', 'status'],
    name_history: ['self_id', 'old_name', 'new_name', 'reason', 'source', 'changed_at'],
    persona_versions: ['self_id', 'version', 'content', 'content_hash', 'created_at'],
    emotion_state: ['self_id', 'valence', 'arousal', 'certainty', 'label', 'intensity', 'confidence', 'source', 'energy', 'social', 'ess_updated_at', 'updated_at'],
    emotion_timeline: ['self_id', 'at', 'valence', 'arousal', 'label', 'intensity', 'trigger', 'msg_ref'],
    emotion_points: ['self_id', 'at', 'dimension', 'delta', 'value_after', 'trigger', 'msg_ref'],
    emotion_audit: ['at', 'self_id', 'action', 'before_json', 'after_json', 'note'],
    emotion_episodes: ['self_id', 'at', 'emotion', 'intensity', 'cause', 'target', 'half_life_s', 'expires_at', 'appraisal_id', 'msg_ref'],
    emotion_event: ['self_id', 'at', 'kind', 'actor', 'subject', 'target', 'goal', 'goal_congruence', 'certainty', 'novelty', 'source_ref', 'excerpt', 'payload_json', 'confidence'],
    emotion_appraisal: ['event_id', 'self_id', 'at', 'rule_id', 'emotion', 'intensity', 'valence', 'arousal', 'cause', 'target', 'confidence', 'accepted', 'source'],
  })) {
    for (const col of need) assert.ok(cols(db, table).includes(col), `${table}.${col} 应存在`)
  }
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, String(SCHEMA_VERSION))
  db.close()
})

test('F14 v1 骨架库迁移后补齐列且数据不丢', () => {
  const dir = tmpDir()
  const path = join(dir, 'persona.db')
  const v1 = makeV1Db(path)
  v1.close()

  const db = openDb(path) // openDb 内含建表 + migrateToV2
  assert.deepEqual(cols(db, 'self').includes('name_version'), true)
  assert.deepEqual(cols(db, 'emotion_timeline').filter((c) => ['intensity', 'trigger', 'msg_ref'].includes(c)).sort(), [
    'intensity',
    'msg_ref',
    'trigger',
  ])
  assert.deepEqual(cols(db, 'emotion_points').filter((c) => ['value_after', 'trigger', 'msg_ref'].includes(c)).sort(), [
    'msg_ref',
    'trigger',
    'value_after',
  ])
  // 旧列保留（不删）
  assert.ok(cols(db, 'emotion_timeline').includes('source'))
  // 数据不丢
  assert.equal(db.prepare('SELECT display_name FROM self').get().display_name, '汐')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM emotion_timeline').get().c, 1)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM name_history').get().c, 1)
  db.close()
})

test('F14 迁移幂等：第二次不重复加列', () => {
  const dir = tmpDir()
  const path = join(dir, 'persona.db')
  makeV1Db(path).close()
  const db = openDb(path)
  const again = migrateToV2(db)
  assert.deepEqual(again.added, [])
  const third = migrateToV2(db)
  assert.deepEqual(third.added, [])
  db.close()
})

test('迁移脚本 dry-run 不写库、--apply 才写', async () => {
  const dir = tmpDir()
  const path = join(dir, 'persona.db')
  makeV1Db(path).close()
  const { execFileSync } = await import('node:child_process')
  const script = new URL('../scripts/migrate-v1-v2.mjs', import.meta.url).pathname
  const out1 = execFileSync(process.execPath, [script, `--db=${path}`], { encoding: 'utf8' })
  assert.match(out1, /DRY-RUN/)
  const check = new DatabaseSync(path)
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='meta'").get(), undefined)
  check.close()
  const out2 = execFileSync(process.execPath, [script, `--db=${path}`, '--apply'], { encoding: 'utf8' })
  assert.match(out2, /已补列/)
  const after = new DatabaseSync(path)
  assert.ok(after.prepare('PRAGMA table_info(self)').all().some((r) => r.name === 'name_version'))
  after.close()
})

test('回滚脚本 copy 模式导出 v1 结构且不动原库', async () => {
  const dir = tmpDir()
  const path = join(dir, 'persona.db')
  makeV1Db(path).close()
  const db = openDb(path)
  db.close()
  const out = join(dir, 'v1-copy.db')
  const { execFileSync } = await import('node:child_process')
  const script = new URL('../scripts/rollback-v2-v1.mjs', import.meta.url).pathname
  execFileSync(process.execPath, [script, `--db=${path}`, `--out=${out}`, '--apply'], { encoding: 'utf8' })
  const copy = new DatabaseSync(out)
  assert.equal(copy.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '1')
  assert.equal(copy.prepare('PRAGMA table_info(self)').all().some((r) => r.name === 'name_version'), false)
  copy.close()
  const src = new DatabaseSync(path)
  assert.equal(src.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, String(SCHEMA_VERSION))
  src.close()
})
