import test from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import {
  applyAppraisalToState, composeEmotionView, currentState, decayState, ensureState, recordRuleEpisode,
} from '../lib/emotion.js'

const DIR = mkdtempSync(join(tmpdir(), 'persona-mood-'))
const db = openDb(join(DIR, 'persona.db'))
const SELF = ensureSelf(db, '汐', 'self:test-mood').id

test('migration：emotion_state 有 mood/dominance 列，默认值正确', () => {
  const cols = db.prepare('PRAGMA table_info(emotion_state)').all().map((c) => c.name)
  for (const c of ['dominance', 'mood_valence', 'mood_arousal', 'mood_updated_at']) assert.ok(cols.includes(c), c)
  const row = ensureState(db, SELF)
  assert.equal(Number(row.dominance), 0.5)
  assert.equal(Number(row.mood_valence), 0)
})

test('被夸：mood 上升、dominance 上升；工具失败反过来', () => {
  const before = ensureState(db, SELF)
  recordRuleEpisode(db, SELF, {
    at: 1_000_000, kind: 'owner_act', actor: 'owner', subject: 'owner', target: 'self',
    ruleId: 'owner_praise', emotion: 'joy', intensity: 0.8, valence: 0.8, arousal: 0.6,
    cause: '被夸', msgRef: 'm1', halfLifeS: 7200,
  })
  const afterPraise = db.prepare('SELECT * FROM emotion_state WHERE self_id=?').get(SELF)
  assert.ok(Number(afterPraise.mood_valence) > Number(before.mood_valence ?? 0), 'mood 应上升')
  assert.ok(Number(afterPraise.dominance) > 0.5, 'dominance 应上升')

  recordRuleEpisode(db, SELF, {
    at: 1_100_000, kind: 'tool_result', actor: 'tool', subject: 'tool', target: 'tool',
    ruleId: 'tool_fail', emotion: 'frustration', intensity: 0.8, valence: -0.8, arousal: 0.7,
    cause: '工具失败', msgRef: 'm2', halfLifeS: 7200,
  })
  const afterFail = db.prepare('SELECT * FROM emotion_state WHERE self_id=?').get(SELF)
  assert.ok(Number(afterFail.dominance) < Number(afterPraise.dominance), '失败应压低 dominance')
})

test('mood 半衰期：48h 后向基线回落一半', () => {
  const st = { valence: 0, arousal: 0.2, label: '平静', intensity: 0.2, energy: 0.7, social: 0.7, updated_at: 0, dominance: 0.7, mood_valence: 0.6, mood_arousal: 0.5, mood_updated_at: 0 }
  const now = 48 * 3600 * 1000
  const d = decayState(st, now, { ...{ valenceHalfLifeHours: 6, arousalHalfLifeHours: 0.5, arousalBaseline: 0.2, moodHalfLifeHours: 48, dominanceHalfLifeHours: 72, dominanceBaseline: 0.5 } })
  assert.ok(Math.abs(d.moodValence - 0.3) < 0.02, `mood 应约 0.3，实际 ${d.moodValence}`)
  assert.ok(Math.abs(d.dominance - 0.626) < 0.02, `dominance 应回 0.626 附近，实际 ${d.dominance}`)
})

test('label 合成：活跃 episode 优先于 valence；没有 episode 才回落到 mood+valence', () => {
  const st = { valence: 0, arousal: 0.2, label: '平静', intensity: 0.2, moodValence: 0.5, energy: 0.7, social: 0.7, dominance: 0.5 }
  const now = 10_000_000
  // 2026-11-12 P0：episode 标签走统一映射表 frustration→生气（旧值是「烦躁」，不在标签白名单里）
  const ep = [{ emotion: 'frustration', target: 'tool', intensity: 0.6, at: now }]
  assert.equal(composeEmotionView(st, ep, { now }).label, '生气')
  assert.equal(composeEmotionView(st, ep, { now }).source, 'episode')
  const noEp = composeEmotionView(st, [], { now })
  assert.equal(noEp.source, 'valence')
  assert.notEqual(noEp.label, '生气')
})

test.after(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })
