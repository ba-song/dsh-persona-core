/** F1/F2/F10：改名不动 self_id 与 persona_version；self 冲突拒绝启动。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openDb, E } from '../lib/db.js'
import { ensureSelf, nameHistory, renameSelf, syncPersonaVersion } from '../lib/self.js'
import { tmpDir } from './helpers/fixtures.mjs'

test('N1 首启生成稳定 self_id 且只有一行 active', () => {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  assert.match(self.id, /^self:/)
  assert.equal(ensureSelf(db, '别的名字').id, self.id, '第二次调用必须返回同一行')
  assert.equal(db.prepare("SELECT COUNT(*) c FROM self WHERE status='active'").get().c, 1)
  db.close()
})

test('F1/F2 改名：self_id 与 persona_version 不变，只加 name_version 与历史', () => {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  syncPersonaVersion(db, self.id, '# 我是谁\n名字：{{display_name}}\n')
  const before = db.prepare('SELECT * FROM self WHERE id=?').get(self.id)

  const after = renameSelf(db, self.id, '小汐', { reason: '测试改名' })
  assert.equal(after.id, before.id, 'self_id 不变')
  assert.equal(after.display_name, '小汐')
  assert.equal(after.persona_version, before.persona_version, '改名不动 persona_version')
  assert.equal(Number(after.name_version), Number(before.name_version) + 1)

  const hist = nameHistory(db, self.id)
  assert.equal(hist.length, 1)
  assert.equal(hist[0].old_name, '汐')
  assert.equal(hist[0].new_name, '小汐')
  assert.equal(hist[0].source, 'tool')
  db.close()
})

test('F1 改名后情绪数据仍按 self_id 可查（行数不变）', () => {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  const at = Date.now()
  db.prepare("INSERT INTO emotion_state(self_id,valence,arousal,certainty,label,intensity,confidence,source,updated_at) VALUES(?,0.4,0.5,0.5,'开心',0.5,0.6,'rule',?)").run(self.id, at)
  db.prepare("INSERT INTO emotion_timeline(self_id,at,valence,arousal,label,intensity,trigger,msg_ref) VALUES(?,?,0.4,0.5,'开心',0.5,'','')").run(self.id, at)

  renameSelf(db, self.id, '新名字')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM emotion_timeline WHERE self_id=?').get(self.id).c, 1)
  assert.equal(db.prepare('SELECT label FROM emotion_state WHERE self_id=?').get(self.id).label, '开心')
  db.close()
})

test('重名不变更（幂等）：不改 name_version、不写历史', () => {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  const same = renameSelf(db, self.id, '汐')
  assert.equal(same.unchanged, true)
  assert.equal(nameHistory(db, self.id).length, 0)
  assert.equal(Number(same.name_version), Number(self.name_version))
  db.close()
})

test('F10 self 多行 active → ensureSelf 抛 E_SELF_CONFLICT', () => {
  const db = openDb(join(tmpDir(), 'persona.db'))
  ensureSelf(db, '汐')
  // 模拟「索引没能建起来」的历史脏库：先删索引，再插两行 active
  db.exec('DROP INDEX IF EXISTS ux_self_single_active')
  db.exec("UPDATE self SET status='inactive'")
  const at = Date.now()
  db.prepare("INSERT INTO self(id,display_name,name_version,persona_version,status,created_at,updated_at) VALUES('self:a','A',0,1,'active',?,?)").run(at, at)
  db.prepare("INSERT INTO self(id,display_name,name_version,persona_version,status,created_at,updated_at) VALUES('self:b','B',0,1,'active',?,?)").run(at, at)
  assert.throws(() => ensureSelf(db, '汐'), (err) => err.code === E.SELF_CONFLICT)
  db.close()
})

test('persona_version 只随 persona.md hash 变，改名不影响', () => {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  const v1 = syncPersonaVersion(db, self.id, '# 我是谁\n名字：{{display_name}}\n')
  assert.equal(v1.version, 1)
  const again = syncPersonaVersion(db, self.id, '# 我是谁\n名字：{{display_name}}\n')
  assert.equal(again.bumped, false, '同内容不升版本')
  renameSelf(db, self.id, '小汐')
  const afterRename = syncPersonaVersion(db, self.id, '# 我是谁\n名字：{{display_name}}\n')
  assert.equal(afterRename.version, 1, '改名不改模板，hash 不变')
  const v2 = syncPersonaVersion(db, self.id, '# 我是谁\n名字：{{display_name}}\n# 性格\n- 更直接\n')
  assert.equal(v2.version, 2, '内容变了才升版本')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM persona_versions WHERE self_id=?').get(self.id).c, 2)
  db.close()
})
