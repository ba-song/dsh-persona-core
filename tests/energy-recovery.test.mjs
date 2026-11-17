/**
 * 精力/社交电量修复：恢复率、睡眠恢复、floor/cap。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { DEFAULTS, applyHomeostasis, ensureState, homeostasisAt } from '../lib/emotion.js'
import { tmpDir } from './helpers/fixtures.mjs'

function fresh() {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  return { db, self }
}

test('白天 50 次交互后 energy 仍 ≥0.2（不被聊空）', () => {
  const { db, self } = fresh()
  const at = Date.UTC(2026, 10, 7, 4, 0) // 北京时间 12:00
  db.prepare('update emotion_state set energy=?, social=?, ess_updated_at=? where self_id=?').run(0.7, 0.5, at, self.id)
  for (let i = 0; i < 50; i++) applyHomeostasis(db, self.id, at)
  const row = db.prepare('select energy,social from emotion_state where self_id=?').get(self.id)
  assert.ok(row.energy >= 0.2, `energy 不应低于 0.2，实际 ${row.energy}`)
  assert.ok(row.social <= 0.95, `social 不应超过 0.95，实际 ${row.social}`)
  db.close()
})

test('跨 8h 首次交互：energy 至少 0.55，且不会无条件拉满', () => {
  const { db, self } = fresh()
  const now = Date.UTC(2026, 10, 7, 12, 0) // 北京时间 20:00
  db.prepare('update emotion_state set energy=?, social=?, ess_updated_at=? where self_id=?').run(0.1, 0.5, now - 8 * 3600_000, self.id)
  const out = applyHomeostasis(db, self.id, now)
  assert.ok(out.energy >= 0.55, `跨 8h 应至少 0.55，实际 ${out.energy}`)
  assert.ok(out.energy < 1, `不应拉满，实际 ${out.energy}`)
  const row = db.prepare('select energy from emotion_state where self_id=?').get(self.id)
  assert.equal(row.energy, out.energy)
  db.close()
})

test('耗尽后能恢复：floor 0.2 → 8h 后回到 ≥0.55', () => {
  const { db, self } = fresh()
  const t0 = Date.UTC(2026, 10, 7, 4, 0)
  db.prepare('update emotion_state set energy=?, social=?, ess_updated_at=? where self_id=?').run(0.2, 0.5, t0, self.id)
  for (let i = 0; i < 50; i++) applyHomeostasis(db, self.id, t0)
  assert.equal(db.prepare('select energy from emotion_state where self_id=?').get(self.id).energy, 0.2)
  const out = applyHomeostasis(db, self.id, t0 + 8 * 3600_000)
  assert.ok(out.energy >= 0.55, `耗尽后应恢复，实际 ${out.energy}`)
  db.close()
})

test('夜间 +0.05/h、白天 +0.015/h；social 每小时 -0.01；cap 0.95', () => {
  const night = Date.UTC(2026, 10, 6, 16, 0) // 北京 00:00
  const n = homeostasisAt({ energy: 0.5, social: 0.5, ess_updated_at: night }, night + 3600_000)
  assert.equal(n.energy.toFixed(3), '0.550')
  assert.equal(n.social.toFixed(2), '0.49')

  const day = Date.UTC(2026, 10, 6, 4, 0) // 北京 12:00
  const d = homeostasisAt({ energy: 0.5, social: 0.5, ess_updated_at: day }, day + 3600_000)
  assert.equal(d.energy.toFixed(3), '0.515')
  assert.equal(d.social.toFixed(2), '0.49')

  const cap = homeostasisAt({ energy: 0.8, social: 1.0, ess_updated_at: day }, day + 1)
  assert.equal(cap.social, 0.95)
})

test('正向交互 social 饱和在 0.95，不会到 1.0', () => {
  const { db, self } = fresh()
  const at = Date.UTC(2026, 10, 7, 4, 0)
  db.prepare('update emotion_state set energy=?, social=?, ess_updated_at=? where self_id=?').run(0.7, 0.99, at, self.id)
  const out = applyHomeostasis(db, self.id, at, { positive: true })
  assert.equal(out.social, 0.95)
  db.close()
})
