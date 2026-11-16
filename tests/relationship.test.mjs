/**
 * 关系轴（lib/relationship.js）单测。
 *
 * 定值 fixture 来自 Anima 作者的生产数值（report-B M4/M5 实测）：
 *   5× advance({trust:1,warmth:2,disclosure:1,tension:0}) @ 同一时刻 →
 *   trust=0.13992011011682284 warmth=0.16436462365279764 familiarity=0.11489559135750367
 * 我们照用 Anima 的四轴初值（0.08/0.1/0.06/0），所以这四个定点值必须逐位命中。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import {
  REL_AXES,
  REL_DEFENSE,
  DAILY_MOTION_CAP,
  PER_CALL_CAP,
  initialAxes,
  bandsOf,
  decayAxes,
  advanceAxes,
  seededDaily,
  localDayKey,
  relationshipLine,
  peerIdOf,
  advanceRelationship,
  relationshipOf,
  loadRelationship,
  writeAttunement,
  normalizeAttunement,
} from '../lib/relationship.js'
import { tmpDir } from './helpers/fixtures.mjs'

const T0 = 1728000000000 // 2024-10-04T00:00:00Z（= 北京 08:00）
const near = (a, b, tol = 1e-12) => Math.abs(Number(a) - Number(b)) <= tol
const newDb = () => openDb(join(tmpDir('rel-test-'), 'persona.db'))

test('R1 连打 5 次命中 Anima 生产 fixture（4 轴，无 pad）', () => {
  let s = initialAxes(T0)
  const AP = { emotion: 'warm', intensity: 2, trust: 1, warmth: 2, disclosure: 1, tension: 0 }
  for (let i = 0; i < 5; i++) s = advanceAxes(s, AP, T0)
  assert.ok(near(s.axes.trust, 0.13992011011682284), `trust=${s.axes.trust}`)
  assert.ok(near(s.axes.warmth, 0.16436462365279764), `warmth=${s.axes.warmth}`)
  assert.ok(near(s.axes.familiarity, 0.11489559135750367), `fam=${s.axes.familiarity}`)
  assert.equal(s.axes.tension, 0)
  // 只该有这 4 根轴（romance 已去掉）
  assert.deepEqual(Object.keys(s.axes).sort(), [...REL_AXES].sort())
})

test('R2 日累计位移 ≤ 0.12/轴（含极端 appraisal），且单轮 ≤ PER_CALL_CAP', () => {
  let s = initialAxes(T0)
  const AP = { emotion: 'calm', trust: 500, warmth: 500, disclosure: 500, tension: 500 }
  s = advanceAxes(s, AP, T0)
  for (const k of REL_AXES) assert.ok(s.motion[k] <= PER_CALL_CAP + 1e-9, `${k} 单轮 ${s.motion[k]}`)
  for (let i = 0; i < 100; i++) s = advanceAxes(s, AP, T0)
  for (const k of REL_AXES) {
    assert.ok(s.motion[k] <= DAILY_MOTION_CAP + 1e-9, `${k} 当日累计 ${s.motion[k]}`)
  }
  // 帽打满后同一天再怎么打都不动
  const before = { ...s.axes }
  const more = advanceAxes(s, AP, T0)
  for (const k of REL_AXES) assert.equal(more.axes[k], before[k], `${k} 当日预算已用尽`)
})

test('R3 跨本地日：motion/repeats 归零，位移额度恢复', () => {
  let s = initialAxes(T0)
  const AP = { emotion: 'warm', trust: 500, warmth: 0, disclosure: 0, tension: 0 }
  for (let i = 0; i < 50; i++) s = advanceAxes(s, AP, T0) // 打满当日 trust 预算
  const capped = s.axes.trust
  assert.ok(s.motion.trust >= DAILY_MOTION_CAP - 1e-9)
  // 北京 2024-10-05 00:00:30 → 已跨本地日（UTC 日界仍是 10-04，用来证明我们没照抄 UTC）
  const nextDay = Date.parse('2024-10-05T00:00:30+08:00')
  assert.equal(localDayKey(nextDay), '2024-10-05')
  assert.equal(localDayKey(nextDay, 'UTC'), '2024-10-04')
  // 先验证"跨日重置"本身：不带位移地推进一轮，motion 必须归零
  const reset = advanceAxes(s, { trust: 0, warmth: 0, disclosure: 0, tension: 0 }, nextDay)
  assert.equal(reset.day_key, '2024-10-05')
  for (const k of REL_AXES) assert.equal(reset.motion[k], 0, `${k} 跨日应归零`)
  // 再验证额度恢复：新一天的位移不再被昨天的 motion 挡住
  s = advanceAxes(reset, { ...AP, trust: 1 }, nextDay + 60000)
  assert.ok(s.motion.trust > 0 && s.motion.trust <= PER_CALL_CAP + 1e-9)
  assert.ok(s.axes.trust > capped, `跨日后应还能涨：${capped} → ${s.axes.trust}`)
  assert.equal(s.day_key, '2024-10-05')
})

test('R4 长缺席"分区不变"：decay(decay(s,t10),t20) 与 decay(s,t20) 逐位相等', () => {
  let s = initialAxes(T0)
  s.axes.warmth = 0.8
  s.axes.familiarity = 0.2
  const t10 = T0 + 10 * 86400000
  const t20 = T0 + 20 * 86400000
  const direct = decayAxes(s, t20)
  const split = decayAxes(decayAxes(s, t10), t20)
  for (const k of REL_AXES) assert.equal(split.axes[k], direct.axes[k], `${k} 分区不等`)
  assert.ok(near(direct.axes.warmth, split.axes.warmth, 0))
  // 同一 now 连读两次幂等
  assert.deepEqual(decayAxes(direct, t20).axes, direct.axes)

  // 7 天宽限：离开 5 天不掉 warmth
  const t5 = T0 + 5 * 86400000
  assert.equal(decayAxes(s, t5).axes.warmth, 0.8)
})

test('R5 读不写：decayAxes 不改入参、relationshipOf 不落行', () => {
  const s = initialAxes(T0)
  s.axes.trust = 0.3
  const snapshot = JSON.stringify(s)
  decayAxes(s, T0 + 3 * 86400000)
  assert.equal(JSON.stringify(s), snapshot, 'decayAxes 不许改入参')

  const db = newDb()
  const selfId = 'self:rel-read'
  const before = relationshipOf(db, selfId, 'owner', T0)
  assert.equal(loadRelationship(db, selfId, 'owner'), null, '只读预览不许建行')
  assert.equal(typeof before.axes.trust, 'number')
  // 预览也要是合法带宽
  for (const k of REL_AXES) assert.ok(before.bands[k] >= 0 && before.bands[k] <= 3)
  db.close()
})

test('R6 滞回上下行边界（阈值 0.25 的那道）', () => {
  assert.equal(bandsOf({ warmth: 0.284 }, { warmth: 0 }).warmth, 0, '0.284 上行不够 0.285')
  assert.equal(bandsOf({ warmth: 0.286 }, { warmth: 0 }).warmth, 1, '0.286 上行越档')
  assert.equal(bandsOf({ warmth: 0.216 }, { warmth: 1 }).warmth, 1, '0.216 下行不够 0.215')
  assert.equal(bandsOf({ warmth: 0.214 }, { warmth: 1 }).warmth, 0, '0.214 下行越档')
  // 无历史时直接取 raw（Anima 同口径）
  assert.equal(bandsOf({ warmth: 0.26 }, null).warmth, 1)
  // tension 用另一套阈值
  assert.equal(bandsOf({ tension: 0.15 }, {}).tension, 1)
  assert.equal(bandsOf({ tension: 0.14 }, {}).tension, 0)
  assert.equal(bandsOf({ tension: 0.7 }, {}).tension, 3)
  // 三档全测（0.51/0.76 都还在 0.035 死区里，不许翻档；越过才翻）
  assert.equal(bandsOf({ trust: 0.51 }, { trust: 1 }).trust, 1, '0.51 在 0.5 阈值死区内')
  assert.equal(bandsOf({ trust: 0.54 }, { trust: 1 }).trust, 2, '0.54 越过 0.535')
  assert.equal(bandsOf({ trust: 0.76 }, { trust: 2 }).trust, 2, '0.76 在 0.75 阈值死区内')
  assert.equal(bandsOf({ trust: 0.79 }, { trust: 2 }).trust, 3, '0.79 越过 0.785')
})

test('R7 两联系人隔离：A 的推进不碰 B', () => {
  const db = newDb()
  const selfId = 'self:rel-iso'
  advanceRelationship(db, selfId, '10001', { emotion: 'affection', intensity: 0.9, valence: 0.9 }, T0)
  const a = loadRelationship(db, selfId, '10001')
  assert.ok(a.axes.warmth > 0.1, 'A 应该涨了')
  assert.equal(loadRelationship(db, selfId, '10002'), null, 'B 不该被建行')

  advanceRelationship(db, selfId, '10002', { emotion: 'anger', intensity: 0.8, valence: -0.8 }, T0)
  const b = loadRelationship(db, selfId, '10002')
  assert.ok(b.axes.tension > 0, 'B 该有张力')
  assert.equal(loadRelationship(db, selfId, '10001').axes.tension, a.axes.tension, 'A 的张力不该被 B 带起来')
  assert.deepEqual(loadRelationship(db, selfId, '10001').axes, a.axes)
  db.close()
})

test('R8 relationshipLine：非空、含防御句、无数字、档 0 张力不出现双空格', () => {
  const s = initialAxes(T0)
  const line = relationshipLine(s)
  assert.ok(line.length > 20)
  assert.ok(line.includes(REL_DEFENSE), '必须带固定防御收尾')
  assert.doesNotMatch(line, /\d/, '注入行不带数字')
  assert.ok(line.startsWith('【关系底色】'))
  assert.ok(!line.includes('  '), `不许双空格：${line}`)
  // 高张力档会多一段
  const tense = { ...s, bands: { ...s.bands, tension: 2 } }
  assert.ok(relationshipLine(tense).includes('没解决的紧绷'))
  // 归档：band 3 的文案（修复语义）
  assert.ok(relationshipLine({ ...s, bands: { ...s.bands, tension: 3 } }).includes('留出修复的空间'))
  // 未知/坏 state 也不许抛
  assert.ok(relationshipLine(null).includes(REL_DEFENSE))
  assert.ok(relationshipLine({ axes: { trust: 'x' } }).includes(REL_DEFENSE))
})

test('R9 peerIdOf：显式 contactId > QQ 私聊目录名 > 群 > owner', () => {
  assert.equal(peerIdOf({ cwd: '/sdcard/DSHA/生活/数据/home' }), 'owner')
  assert.equal(peerIdOf({ contactId: '42', cwd: '/whatever' }), '42')
  assert.equal(peerIdOf({ cwd: '/sdcard/DSHA/渠道/qq-私聊/2971030080/' }), '2971030080')
  assert.equal(peerIdOf({ cwd: '/sdcard/DSHA/渠道/qq-群/123456' }), 'group:123456')
  assert.equal(peerIdOf({ session: { header: { peerId: 'p-1' } } }), 'p-1')
  assert.equal(peerIdOf(null), 'owner')
})

test('R10 负向 warmth 也有重复折扣（我们相对 Anima 的修正）', () => {
  // 同基线（warmth=0.5、同一时刻、当日额度未用）只改 repeats_neg → 负向位移应更小
  const base = () => {
    const s = initialAxes(T0)
    s.axes.warmth = 0.5
    s.day_key = localDayKey(T0)
    return s
  }
  const fresh = base()
  const habituated = { ...base(), repeats_neg: 4 }
  const dropFresh = advanceAxes(fresh, { warmth: -1 }, T0).axes.warmth - 0.5
  const dropHab = advanceAxes(habituated, { warmth: -1 }, T0).axes.warmth - 0.5
  assert.ok(dropFresh < 0 && dropHab < 0)
  assert.ok(dropHab > dropFresh, `负向应被重复折扣压小：fresh=${dropFresh} hab=${dropHab}`)
  // 反向：正向习惯化（Anima 原样）
  const a = advanceAxes(initialAxes(T0), { warmth: 1 }, T0)
  const c = advanceAxes(a, { warmth: 1 }, T0)
  const gain1 = a.axes.warmth - initialAxes(T0).axes.warmth
  const gain2 = c.axes.warmth - a.axes.warmth
  assert.ok(gain1 > gain2, '正向应递减')
  assert.ok(gain2 > 0)
  assert.equal(a.repeats, 1)
  assert.equal(c.repeats, 2)
})

test('R11 seededDaily：双字节 FNV-1a 变体、可复现、范围 [-1,1)；wobble 同日幂等', () => {
  const v1 = seededDaily('local:char:2024-10-04:p')
  const v2 = seededDaily('local:char:2024-10-04:p')
  assert.equal(v1, v2, '同参必同值')
  assert.notEqual(v1, seededDaily('local:char:2024-10-05:p'), '不同日应不同')
  for (const s of ['a', 'b', '主人:汐:2024-10-04:a', 'x'.repeat(50)]) {
    const v = seededDaily(s)
    assert.ok(v >= -1 && v < 1, `${v} 越界`)
  }
  // 这是 UTF-16LE 双字节变体，不是逐字节标准 FNV-1a：与"逐字节"结果必须不同
  const byteWise = (str) => {
    let h = 2166136261
    for (const b of Buffer.from(str, 'utf8')) h = Math.imul((h ^ b) >>> 0, 16777619) >>> 0
    return (h % 20000) / 10000 - 1
  }
  // 纯 ASCII 时双字节与逐字节恰好同值（UTF-16LE 高字节为 0），CJK 才会分叉——
  // 所以"照名字用标准 FNV-1a"在中文种子下会得到完全不同的一天天气。
  const ascii = 'seed:2024-10-04:p'
  assert.equal(seededDaily(ascii), byteWise(ascii), 'ASCII 下两者同值（正常）')
  const cjk = '主人:汐:2024-10-04:p'
  assert.notEqual(seededDaily(cjk), byteWise(cjk), 'CJK 种子必须分叉（证明用的是双字节变体）')

  const s = initialAxes(T0)
  const a = decayAxes(s, T0, { seed: 'seed-A' })
  const b = decayAxes(a, T0, { seed: 'seed-A' })
  assert.equal(b.wobble_day, a.wobble_day, '同日不重抽')
  assert.deepEqual(b.wobble, a.wobble)
  const next = decayAxes(a, T0 + 86400000, { seed: 'seed-A' })
  assert.notEqual(next.wobble_day, a.wobble_day)
})

test('R12 attunement：intent 白名单、字段截断、avoid 上限、非法不抛', () => {
  assert.equal(normalizeAttunement(null), null)
  assert.equal(normalizeAttunement({}), null)
  const ok = normalizeAttunement({ intent: 'listen', user_cue: '主人想被听', uncertainty: '不确定是否只是抱怨', avoid: ['别给建议', '', '别问为什么', '别总结', '别下结论'] })
  assert.equal(ok.intent, 'listen')
  assert.equal(ok.avoid.length, 4, '空串被过滤')
  const many = normalizeAttunement({ intent: 'space', avoid: Array.from({ length: 20 }, (_, i) => `别${i}`) })
  assert.equal(many.avoid.length, 8, 'avoid 上限 8（Anima 口径）')
  assert.equal(normalizeAttunement({ intent: 'bogus', user_cue: 'x' }).intent, '', '非法 intent 落空串')
  const long = normalizeAttunement({ intent: 'answer', user_cue: 'x'.repeat(2000) })
  assert.equal(long.userCue.length, 500)
  assert.equal(normalizeAttunement(['not', 'object']), null)

  const db = newDb()
  db.prepare("INSERT INTO emotion_appraisal(event_id,self_id,at,rule_id,emotion,intensity) VALUES(1,'self:att',?,'r','joy',0.5)").run(T0)
  const id = Number(db.prepare('SELECT id FROM emotion_appraisal ORDER BY id DESC LIMIT 1').get().id)
  const wr = writeAttunement(db, id, { intent: 'repair', user_cue: '主人道歉了', uncertainty: '', avoid: ['别翻旧账'] })
  assert.equal(wr.ok, true)
  const row = db.prepare('SELECT intent,user_cue,uncertainty,avoid_json FROM emotion_appraisal WHERE id=?').get(id)
  assert.equal(row.intent, 'repair')
  assert.equal(row.user_cue, '主人道歉了')
  assert.equal(row.avoid_json, '["别翻旧账"]')
  // 非法 appraisalId / 空 attunement → 不写不抛
  assert.equal(writeAttunement(db, 0, { intent: 'listen' }), null)
  assert.equal(writeAttunement(db, id, {}), null)
  // 新列默认值（老行/未写过的行）
  const cols = db.prepare('PRAGMA table_info(emotion_appraisal)').all().map((r) => r.name)
  for (const c of ['intent', 'user_cue', 'uncertainty', 'avoid_json']) assert.ok(cols.includes(c), `缺列 ${c}`)
  db.close()
})

test('R13 advanceRelationship 失败不抛（无 db / 坏 appraisal / 缺表自愈）', () => {
  assert.equal(advanceRelationship(null, 'self:x', 'owner', { emotion: 'joy' }, T0), null)
  const db = newDb()
  assert.equal(advanceRelationship(db, '', 'owner', { emotion: 'joy' }, T0), null)
  // 数值全坏也必须有合法结果
  const s = advanceRelationship(db, 'self:bad', 'owner', { emotion: null, intensity: 'x', valence: {} }, T0)
  assert.equal(typeof s.axes.trust, 'number')
  assert.ok(s.axes.trust >= 0 && s.axes.trust <= 1)
  db.close()
})
