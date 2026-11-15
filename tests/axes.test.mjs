import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { AXES, listAxes, nudgeAxis, axesText } from '../lib/axes.js'

const DIR = mkdtempSync(join(tmpdir(), 'persona-axes-'))
const db = openDb(join(DIR, 'persona.db'))
const SELF = ensureSelf(db, '汐', 'self:test-axes').id

test('性格底色：初始 4 轴、单次 ±0.03、范围 0..1', () => {
  const init = listAxes(db, SELF)
  assert.equal(init.length, AXES.length)
  const r = nudgeAxis(db, SELF, AXES[0], 0.5)
  assert.equal(r.ok, true)
  assert.ok(r.value <= 0.58 && r.value >= 0.52)
  assert.ok(axesText(db, SELF).includes('【性格底色】'))
})
test.after(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })
