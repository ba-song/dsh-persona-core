import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { openGrievance, listGrievances, resolveGrievance } from '../lib/grievance.js'

const DIR = mkdtempSync(join(tmpdir(), 'persona-grievance-'))
const db = openDb(join(DIR, 'persona.db'))
const SELF = ensureSelf(db, '汐', 'self:test-grievance').id

test('矛盾账本：open 去重累加、list、resolve', () => {
  const a = openGrievance(db, SELF, { cause: '答应的事没做到', severity: 0.5, at: 1000 })
  const b = openGrievance(db, SELF, { cause: '答应的事没做到', at: 2000 })
  assert.equal(a.repeated, false)
  assert.equal(b.repeated, true)
  assert.equal(b.id, a.id)
  const list = listGrievances(db, SELF)
  assert.equal(list.length, 1)
  assert.equal(Number(list[0].repeat_count), 2)
  assert.equal(resolveGrievance(db, SELF, a.id, { note: '说开了' }).ok, true)
  assert.equal(listGrievances(db, SELF).length, 0)
})
test.after(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })
