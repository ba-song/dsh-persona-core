/**
 * P0（2026-11-12，参考 AstrBot memory-brain 情绪层）：
 * 1) 单条消息限速（valence/arousal/dominance ≤ maxDeltaPerMessage，默认 0.12）
 * 2) 标签扩到 11 个规范标签（+3 个历史兼容），labelOf 与 composeEmotionView 映射一致
 * 3) 标签半衰期 labelHalfLifeMinutes（默认 45）：episode 标签过期回落到 valence
 * 4) 注入硬约束句：情绪只影响语气，不影响判断，不能拿情绪拿捏对方
 * 全部合成数据，不读不写生产库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { migrateToV2, openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import {
  CANONICAL_LABELS,
  DEFAULTS,
  EMOTION_LABELS,
  EMOTION_LINE_MAX,
  EMOTION_RULE,
  LABELS,
  LEGACY_LABELS,
  _internal,
  applyAppraisalToState,
  capDelta,
  coarseEmotionLine,
  composeEmotionView,
  decayState,
  emotionLine,
  emotionLineFor,
  ensureState,
  ingestEmotion,
  labelForEmotion,
  labelOf,
  points,
  recordConcernEpisode,
  recordToolFailureEpisode,
  scoreText,
} from '../lib/emotion.js'
import { loadConfig } from '../lib/config.js'
import { createPersonaService } from '../lib/service.js'
import { makeV1Db, tmpDir } from './helpers/fixtures.mjs'

const HOME = '/tmp/fixture-owner-private'
const GROUP = '/tmp/fixture-qq/群_123456'
const TONE = _internal.TONE

function freshDb() {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  return { db, self }
}

function ingest(db, self, text, opts = {}) {
  return ingestEmotion(db, self.id, {
    text,
    msgRef: `explicit:p0:${Math.random().toString(16).slice(2)}`,
    at: Date.now(),
    opts: { ...DEFAULTS, ...opts },
    forceAudit: true,
  })
}

// ───────────────────────── 1. 情绪限速 ─────────────────────────

test('限速：一条极端消息（平静→暴怒）单次 valence/arousal 变化都 ≤0.12', () => {
  const { db, self } = freshDb()
  const raw = scoreText('气死我了，烦死了！！')
  assert.ok(raw.valence < -0.5, `原始打分应很负，实际 ${raw.valence}`) // 证明是限速在起作用

  const before = db.prepare('select valence,arousal,label from emotion_state where self_id=?').get(self.id)
  const out = ingest(db, self, '气死我了，烦死了！！')
  assert.equal(out.applied, true)
  const after = db.prepare('select valence,arousal,label from emotion_state where self_id=?').get(self.id)
  assert.ok(Math.abs(Number(after.valence) - Number(before.valence)) <= 0.12 + 1e-9, `valence 变化 ${after.valence}`)
  assert.ok(Math.abs(Number(after.arousal) - Number(before.arousal)) <= 0.12 + 1e-9, `arousal 变化 ${after.arousal}`)
  assert.equal(after.label, '平静', '一条消息不能让标签从平静跳到生气')
  db.close()
})

test('capDelta：夹住正负两个方向；非法/≤0 回落默认 0.12', () => {
  assert.equal(capDelta(0, 0.9, 0.12), 0.12)
  assert.equal(capDelta(0.5, -0.5, 0.12), 0.38)
  assert.equal(capDelta(0.1, 0.15, 0.12), 0.15, '未超上限时原样返回')
  assert.equal(capDelta(0, 0.9, 0), 0.12)
  assert.equal(capDelta(0, 0.9, -1), 0.12)
  assert.equal(capDelta(0, 0.9, 'x'), 0.12)
  assert.equal(capDelta(0, 0.9), DEFAULTS.maxDeltaPerMessage)
  assert.equal(DEFAULTS.maxDeltaPerMessage, 0.12)
})

test('限速可配：maxDeltaPerMessage 决定单次幅度；非法/≤0 回落 0.12', () => {
  const val = (maxDelta) => {
    const { db, self } = freshDb()
    ingest(db, self, '气死我了，烦死了！！', { maxDeltaPerMessage: maxDelta })
    const v = Number(db.prepare('select valence from emotion_state where self_id=?').get(self.id).valence)
    db.close()
    return v
  }
  const small = val(0.05)
  const mid = val(0.3)
  assert.ok(Math.abs(small) <= 0.05 + 1e-9, `0.05 上限，实际 ${small}`)
  assert.ok(Math.abs(mid) > Math.abs(small) + 0.1, `0.3 上限应明显更大：${small} vs ${mid}`)
  assert.ok(Math.abs(val('x')) <= 0.12 + 1e-9, '非法值应回落默认 0.12')
  assert.equal(loadConfig({}).emotion.maxDeltaPerMessage, 0.12)
  assert.equal(loadConfig({ emotion: { maxDeltaPerMessage: 0.3 } }).emotion.maxDeltaPerMessage, 0.3)
  assert.equal(loadConfig({ emotion: { maxDeltaPerMessage: 0 } }).emotion.maxDeltaPerMessage, 0.12)
  assert.equal(loadConfig({ emotion: { maxDeltaPerMessage: -1 } }).emotion.maxDeltaPerMessage, 0.12)
})

test('限速是「每次上限」：连续消息仍能累积，不是封顶', () => {
  const { db, self } = freshDb()
  let prev = 0
  for (let i = 0; i < 6; i += 1) {
    ingest(db, self, '太好了，我真的好开心！')
    const v = Number(db.prepare('select valence from emotion_state where self_id=?').get(self.id).valence)
    assert.ok(v - prev <= 0.12 + 1e-9, `第 ${i + 1} 条单次变化 ${v - prev}`)
    prev = v
  }
  assert.ok(prev > 0.4, `6 条正向消息应累积到 0.4 以上，实际 ${prev}`)
  db.close()
})

test('dominance 单次变化同样受限速（不是只有 valence/arousal）', () => {
  const { db, self } = freshDb()
  const at = Date.now()
  const before = Number(ensureState(db, self.id).dominance)
  // 用超大 intensity 让「原始方向量」远超上限：pride 0.05×10 = 0.5
  const first = applyAppraisalToState(db, self.id, { at, emotion: 'pride', intensity: 10 })
  assert.ok(first.dominance - before <= 0.12 + 1e-9, `dominance 变化 ${first.dominance - before}`)
  assert.ok(first.dominance - before > 0.1, '应真的往上走（不是被算成 0）')
  const second = applyAppraisalToState(db, self.id, {
    at: at + 1,
    emotion: 'pride',
    intensity: 10,
    opts: { ...DEFAULTS, maxDeltaPerMessage: 0.02 },
  })
  assert.ok(second.dominance - first.dominance <= 0.02 + 1e-9, `0.02 上限时变化 ${second.dominance - first.dominance}`)
  db.close()
})

test('转折点阈值不高于单次上限：被限速的大变化仍能记点（溯源不断档）', () => {
  const { db, self } = freshDb()
  ingest(db, self, '气死我了，烦死了！！')
  const made = points(db, self.id, 24)
  assert.ok(made.length >= 1, '极端消息应记至少一个转折点')
  for (const p of made) assert.ok(Math.abs(Number(p.delta)) <= 0.12 + 1e-9, `转折点 delta ${p.delta}`)
  db.close()
})

// ───────────────────────── 2. 11 个标签 ─────────────────────────

test('标签集合：11 个规范标签 + 3 个历史兼容，TONE 全覆盖且不重复', () => {
  const required = ['开心', '生气', '难过', '害怕', '委屈', '害羞', '得意', '感动', '焦虑', '无聊', '平静']
  for (const label of required) assert.ok(LABELS.includes(label), `缺规范标签 ${label}`)
  assert.equal(CANONICAL_LABELS.length, 11)
  assert.deepEqual([...LEGACY_LABELS].sort(), ['低落', '兴奋', '疲惫'].sort())
  assert.equal(new Set(LABELS).size, LABELS.length, '标签不能重复')
  for (const label of LABELS) assert.ok(typeof TONE[label] === 'string' && TONE[label].length > 0, `TONE 缺 ${label}`)
})

test('labelOf 两参数：旧口径完全保留（旧调用方/旧数据兼容）', () => {
  assert.equal(labelOf(0, 0.2), '平静')
  assert.equal(labelOf(0.3, 0.3), '开心')
  assert.equal(labelOf(0.3, 0.8), '兴奋')
  assert.equal(labelOf(-0.6, 0.3), '难过')
  assert.equal(labelOf(-0.6, 0.8), '生气')
  assert.equal(labelOf(-0.2, 0.6), '焦虑')
  assert.equal(labelOf(-0.2, 0.2), '低落')
})

test('labelOf 三参数（PAD）：11 个规范标签都能落到', () => {
  const cases = {
    开心: [0.4, 0.2, 0.5],
    生气: [-0.7, 0.7, 0.5],
    难过: [-0.6, 0.2, 0.5],
    害怕: [-0.6, 0.7, 0.2],
    委屈: [-0.3, 0.5, 0.2],
    害羞: [0.3, 0.6, 0.2],
    得意: [0.6, 0.3, 0.8],
    感动: [0.5, 0.2, 0.5],
    焦虑: [-0.3, 0.7, 0.5],
    无聊: [-0.3, 0.2, 0.5],
    平静: [0, 0.2, 0.5],
  }
  for (const [want, args] of Object.entries(cases)) {
    assert.equal(labelOf(...args), want, `${JSON.stringify(args)} 应为 ${want}`)
  }
})

test('labelOf 输出恒在 LABELS 内（两参数 + 三参数网格）', () => {
  for (let v = -1; v <= 1.0001; v += 0.1) {
    for (let a = 0; a <= 1.0001; a += 0.1) {
      assert.ok(LABELS.includes(labelOf(v, a)), `两参数 (${v},${a})`)
      for (const d of [0, 0.5, 1]) assert.ok(LABELS.includes(labelOf(v, a, d)), `三参数 (${v},${a},${d})`)
    }
  }
})

test('episode 映射补齐：代码里出现的 emotion 代码都有标签，且都在 LABELS/TONE 里', () => {
  const codes = [
    'joy', 'pride', 'affection', 'relief', 'frustration', 'sadness', 'anger', 'anxiety',
    'fear', 'worry', 'concern', 'loneliness', 'calm', 'fatigue',
    'shy', 'embarrassment', 'moved', 'gratitude', 'boredom', 'injustice',
  ]
  for (const code of codes) {
    const label = labelForEmotion(code)
    assert.ok(LABELS.includes(label), `${code} → ${label} 不在 LABELS`)
    assert.ok(TONE[label], `${code} → ${label} 没有 TONE（注入会回落平静语气）`)
  }
  for (const [code, label] of Object.entries(EMOTION_LABELS)) {
    assert.ok(LABELS.includes(label), `${code} 映射到白名单外标签 ${label}`)
    assert.ok(TONE[label], `${code} → ${label} 缺 TONE`)
  }
  // 11 个规范标签在映射表里都有出处（composeEmotionView 与 labelOf 同一套标签）
  const covered = new Set(Object.values(EMOTION_LABELS))
  for (const label of CANONICAL_LABELS) assert.ok(covered.has(label), `映射表缺 ${label}`)
})

test('composeEmotionView：episode 用统一映射表；未知 emotion/旧标签回落白名单', () => {
  const now = 1_000_000_000
  const base = { valence: 0, arousal: 0.2, intensity: 0.2, dominance: 0.5 }
  const unknown = [{ emotion: 'weird', target: 'self', intensity: 0.5, at: now }]
  assert.equal(composeEmotionView({ ...base, label: '开心' }, unknown, { now }).label, '开心')
  assert.equal(composeEmotionView({ ...base, label: '想念' }, unknown, { now }).label, '平静')
  const concern = [{ emotion: 'concern', target: 'owner', intensity: 0.5, at: now }]
  assert.equal(composeEmotionView({ ...base, label: '平静' }, concern, { now }).label, '焦虑')
})

// ─────────────────────── 3. 标签半衰期 ───────────────────────

function epAt(emotion, at) {
  return [{ emotion, target: 'owner', intensity: 0.5, at }]
}

test('标签半衰期：默认 45 分钟内用 episode 标签，超过就回落到 valence', () => {
  const now = 100_000_000
  const st = { valence: 0, arousal: 0.2, label: '平静', intensity: 0.2, dominance: 0.5 }
  const early = composeEmotionView(st, epAt('concern', now - 10 * 60000), { now })
  assert.equal(early.source, 'episode')
  assert.equal(early.label, '焦虑')

  // 正好一个半衰期仍算新鲜（weight=0.5）
  assert.equal(composeEmotionView(st, epAt('concern', now - 45 * 60000), { now }).source, 'episode')

  const late = composeEmotionView(st, epAt('concern', now - 46 * 60000), { now })
  assert.equal(late.source, 'valence', '超过半衰期应回落到 valence')
  assert.equal(late.episode, null, '过期标签不再带 episode 补充句')
  assert.equal(late.label, labelOf(0, 0.2, 0.5))
  assert.equal(DEFAULTS.labelHalfLifeMinutes, 45)
})

test('标签半衰期可配：短窗口更早回落、长窗口更久保持；非法值回落 45', () => {
  const now = 100_000_000
  const st = { valence: 0, arousal: 0.2, label: '平静', intensity: 0.2, dominance: 0.5 }
  const ep = epAt('concern', now - 30 * 60000)
  assert.equal(composeEmotionView(st, ep, { now, labelHalfLifeMinutes: 20 }).source, 'valence')
  assert.equal(composeEmotionView(st, ep, { now, labelHalfLifeMinutes: 60 }).source, 'episode')
  assert.equal(loadConfig({}).emotion.labelHalfLifeMinutes, 45)
  assert.equal(loadConfig({ emotion: { labelHalfLifeMinutes: 30 } }).emotion.labelHalfLifeMinutes, 30)
  for (const bad of [0, -5, 'x', NaN, Infinity]) {
    assert.equal(loadConfig({ emotion: { labelHalfLifeMinutes: bad } }).emotion.labelHalfLifeMinutes, 45, `非法值 ${bad}`)
  }
})

test('label_updated_at 刷新标签新鲜度：最近一次标签刷新会续期 episode 标签', () => {
  const now = 100_000_000
  const freshState = { valence: 0, arousal: 0.2, label: '平静', intensity: 0.2, dominance: 0.5, labelUpdatedAt: now - 5 * 60000 }
  const staleState = { ...freshState, labelUpdatedAt: now - 50 * 60000 }
  const oldEp = [{ emotion: 'concern', target: 'owner', intensity: 0.5, at: now - 50 * 60000 }]
  assert.equal(composeEmotionView(freshState, oldEp, { now }).source, 'episode', '标签刚刷新过 → 仍用 episode 标签')
  assert.equal(composeEmotionView(staleState, oldEp, { now }).source, 'valence', '标签和 episode 都过期 → 回落 valence')

  // 没有 at 的合成/旧数据：用 label_updated_at 当锚点；都没有时间信息时按新鲜处理
  const noAt = [{ emotion: 'concern', target: 'owner', intensity: 0.5 }]
  assert.equal(composeEmotionView(freshState, noAt, { now }).source, 'episode')
  assert.equal(composeEmotionView(staleState, noAt, { now }).source, 'valence')
  assert.equal(composeEmotionView({ valence: 0, arousal: 0.2, dominance: 0.5 }, noAt, { now }).source, 'episode')
})

test('无 episode 时按 valence 重算：decayState 标签随衰减回落，并带 labelUpdatedAt', () => {
  const now = Date.now()
  const st = { valence: 0.8, arousal: 0.2, updated_at: now, dominance: 0.5, label_updated_at: now - 1000 }
  assert.equal(decayState(st, now, DEFAULTS).label, '感动', '强正向+低唤醒=感动（PAD 口径）')
  assert.equal(decayState(st, now + 6 * 3600e3, DEFAULTS).label, '开心', '6h 后 valence 0.4 → 开心')
  assert.equal(decayState(st, now + 30 * 3600e3, DEFAULTS).label, '平静', '再久回落到平静')
  assert.equal(decayState(st, now, DEFAULTS).labelUpdatedAt, now - 1000)
})

test('旧库迁移：emotion_state 补 label_updated_at 并回填 updated_at；二次迁移幂等', () => {
  const path = join(tmpDir(), 'persona.db')
  makeV1Db(path).close()
  const db = openDb(path)
  const cols = db.prepare('PRAGMA table_info(emotion_state)').all().map((r) => r.name)
  assert.ok(cols.includes('label_updated_at'), '旧库应补出 label_updated_at 列')
  const row = db.prepare('select updated_at,label_updated_at,label from emotion_state').get()
  assert.ok(Number(row.label_updated_at) > 0, '回填后不能是 0')
  assert.equal(Number(row.label_updated_at), Number(row.updated_at), '旧行以 updated_at 回填')
  assert.equal(row.label, '开心', '迁移不丢数据')
  assert.deepEqual(migrateToV2(db).added, [], '第二次迁移不应再加列')
  db.close()
})

test('写库链路：ingest 与 appraisal 都会刷新 label_updated_at', () => {
  const { db, self } = freshDb()
  const at = Date.now() - 60_000
  ingestEmotion(db, self.id, {
    text: '好开心',
    msgRef: 'explicit:p0:ts1',
    at,
    opts: DEFAULTS,
    forceAudit: true,
  })
  let row = db.prepare('select label_updated_at from emotion_state where self_id=?').get(self.id)
  assert.equal(Number(row.label_updated_at), at, 'ingest 应写 label_updated_at=at')

  const at2 = Date.now()
  applyAppraisalToState(db, self.id, { at: at2, emotion: 'joy', intensity: 0.6, valence: 0.6, arousal: 0.5 })
  row = db.prepare('select label_updated_at from emotion_state where self_id=?').get(self.id)
  assert.equal(Number(row.label_updated_at), at2, 'appraisal 也应刷新 label_updated_at')
  db.close()
})

// ─────────────────────── 4. 注入硬约束 ───────────────────────

test('注入硬约束：emotionLine 末尾固定一句、只出现一次、≤60 字、无数字', () => {
  const line = emotionLine({ label: '生气', intensity: 0.8 })
  assert.match(line, /^【你现在的情绪】生气；这轮说话/)
  assert.ok(line.endsWith(EMOTION_RULE), `必须以硬约束结尾：${line}`)
  assert.equal(line.split(EMOTION_RULE).length - 1, 1, '规则句只能出现一次')
  assert.ok(line.length <= EMOTION_LINE_MAX, `长度 ${line.length}`)
  assert.equal(EMOTION_LINE_MAX, 60)
  assert.doesNotMatch(line, /\d/)
  for (const label of LABELS) {
    const one = emotionLine({ label, intensity: 0.9 })
    assert.ok(one.endsWith(EMOTION_RULE), `${label} 行缺规则句`)
    assert.equal(one.split(EMOTION_RULE).length - 1, 1, `${label} 规则句重复`)
    assert.ok(one.length <= EMOTION_LINE_MAX, `${label} 行长度 ${one.length}`)
  }
})

test('低于阈值不注入（也就没有规则句）；粗粒度只给标签', () => {
  assert.equal(emotionLine({ label: '平静', intensity: 0.1 }), '')
  assert.equal(emotionLineFor({ label: '开心', intensity: 0.2 }), '')
  assert.equal(emotionLineFor({ label: '开心', intensity: 0.2 }, { always: true }), '【你现在的情绪】开心')
  assert.equal(coarseEmotionLine({ label: '生气' }), '【你现在的情绪】生气')
  assert.equal(coarseEmotionLine({ label: '想念' }), '【你现在的情绪】平静', '白名单外标签回落平静')
})

test('渠道 episode 行：补充句在规则句之前，规则句只出现一次', () => {
  const dir = tmpDir()
  const db = openDb(join(dir, 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  const at = Date.now()
  recordConcernEpisode(db, self.id, { at, intensity: 0.5, msgRef: 'm1' })
  const cfg = loadConfig({ dataDir: dir, inject: { mode: 'full', sessionDirs: [HOME] } })
  const svc = createPersonaService({ db: () => db, cfg, self: () => self })
  const line = svc._emotionLineFor({ cwd: HOME })
  assert.ok(line.endsWith(EMOTION_RULE), `规则句应在行尾：${line}`)
  assert.equal(line.split(EMOTION_RULE).length - 1, 1, `规则句重复：${line}`)
  assert.match(line, /担心/, `episode 补充句丢了：${line}`)
  assert.ok(line.indexOf('担心') < line.indexOf(EMOTION_RULE), '补充句应在规则句前')
  assert.match(line, /^【你现在的情绪】焦虑；这轮说话/, `episode 标签应走统一映射：${line}`)
  db.close()
})

test('群聊粗粒度：只标签、不带规则句（也不带语气/原因）', () => {
  const dir = tmpDir()
  const db = openDb(join(dir, 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  db.prepare("UPDATE emotion_state SET valence=-0.7, arousal=0.9, label='生气', intensity=0.9, updated_at=? WHERE self_id=?")
    .run(Date.now(), self.id)
  const cfg = loadConfig({ dataDir: dir, inject: { mode: 'full', sessionDirs: [HOME] } })
  const svc = createPersonaService({ db: () => db, cfg, self: () => self })
  const line = svc._emotionLineFor({ cwd: GROUP })
  assert.equal(line, '【你现在的情绪】生气')
  assert.equal(line.includes(EMOTION_RULE), false)
  assert.equal(line.includes('这轮说话'), false)
  db.close()
})

test('工具失败（强度低于阈值）：只给 episode 句也要带硬约束，且不重复', () => {
  const dir = tmpDir()
  const db = openDb(join(dir, 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  recordToolFailureEpisode(db, self.id, { at: Date.now(), msgRef: 't1' })
  const cfg = loadConfig({ dataDir: dir, inject: { mode: 'full', sessionDirs: [HOME] } })
  const svc = createPersonaService({ db: () => db, cfg, self: () => self })
  const line = svc._emotionLineFor({ cwd: HOME })
  assert.match(line, /工具又卡/, `应保留 episode 句：${line}`)
  assert.equal(line.split(EMOTION_RULE).length - 1, 1, `规则句应恰好一次：${line}`)
  assert.ok(line.endsWith(EMOTION_RULE))
  db.close()
})
