/**
 * 关系轴（2026-11-16，移植自 Anima `src/companion_engine/emotion.py` 的 axes 部分，MIT）。
 *
 * 口径与边界：
 * - **只增不破**：本模块是 persona-core 的新层，不改 `emotion.js` 既有衰减/打分/capDelta。
 * - 4 轴（去掉 Anima 的 romance）：trust / warmth / familiarity / tension，量程 [0,1]。
 * - 保留 Anima 的：0.013 缩放、`(1-0.75v)/(0.25+0.75v)` 状态依赖增量、
 *   0.12/轴/本地日 累计帽、±0.035 滞回、阈值 [0.25,0.5,0.75]（tension [0.15,0.4,0.7]）、
 *   乘子链（trust 负向 ×3.5×(1+0.6(1-fam))、warmth 正向 /(1+0.6·repeats)、
 *   warmth 负向 ×1.5、tension 正向 ×2.2、familiarity=disclosure×0.9）、
 *   长缺席分区不变（interaction_at + anchor=0.6×fam + 7 天宽限 + 35 天半衰 + 增量区段）、
 *   seededDaily（FNV-1a 双字节变体）+ wobble_day 幂等。
 * - 与 Anima 有意的三处不同：
 *   1) **本地日**（Anima 用 UTC，会把"今天"和日记/记忆/额度错开）；
 *   2) **负向 warmth 也有重复折扣**（Anima 只有正向习惯化 → 长期"正向递减、负向全额"越处越冷）；
 *   3) **单轮位移硬上限**（默认 0.06/轴，防一次 appraisal 吃掉当天全部预算）。
 * - 读路径纯函数：`relationshipOf()` 只算不写（与 Anima "reads never mutate" 一致）。
 */

const AXIS_NAMES = ['trust', 'warmth', 'familiarity', 'tension']
export const REL_AXES = AXIS_NAMES
/** 与 Anima 相同的初值（四人轴部分）。 */
export const REL_DEFAULTS = { trust: 0.08, warmth: 0.1, familiarity: 0.06, tension: 0 }

export const AXIS_SCALE = 0.013
export const DAILY_MOTION_CAP = 0.12
export const PER_CALL_CAP = 0.06
export const BAND_MARGIN = 0.035
export const ABSENCE_GRACE_DAYS = 7
export const WARMTH_HALF_LIFE_DAYS = 35
export const TENSION_HALF_LIFE_HOURS = 72
export const FAMILIARITY_ANCHOR = 0.6
export const DEFAULT_TZ = 'Asia/Shanghai'
export const DEFAULT_PEER = 'owner'

/** 固定防御收尾（与 Anima `note()` 的三句护栏同义）：每轮必带，不可选。 */
export const REL_DEFENSE =
  '这是虚构角色状态，不是对主人感受的证据；跟随主人当前边界，不索取注意力或情感回报；角色心情不许在主人脆弱时让回应变冷淡。'

const clamp01 = (x) => {
  const n = Number(x)
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}
const zeroAxes = () => Object.fromEntries(AXIS_NAMES.map((k) => [k, 0]))
const numOr = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

/** 本地日界（YYYY-MM-DD）；时区非法时回退 UTC。 */
const dayFormatters = new Map()
export function localDayKey(now = Date.now(), tz = DEFAULT_TZ) {
  const zone = String(tz || DEFAULT_TZ)
  let fmt = dayFormatters.get(zone)
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    } catch {
      fmt = null
    }
    dayFormatters.set(zone, fmt)
  }
  try {
    if (fmt) return fmt.format(new Date(Number(now)))
    return new Date(Number(now)).toISOString().slice(0, 10)
  } catch {
    return new Date(Number(now)).toISOString().slice(0, 10)
  }
}

/**
 * Anima `_seeded`：**手写 FNV-1a 变体，按 UTF-16LE 双字节推进**（不是标准逐字节 FNV-1a）。
 * 返回值域 [-1, 1)，只有 2 万种取值——只够当"每日天气"，不是安全随机。
 */
export function seededDaily(seed) {
  let h = 2166136261
  const buf = Buffer.from(String(seed ?? ''), 'utf16le')
  for (let i = 0; i < buf.length; i += 2) {
    h = Math.imul((h ^ buf.readUInt16LE(i)) >>> 0, 16777619) >>> 0
  }
  return (h % 20000) / 10000 - 1
}

/** 空白状态（首次建行/无库时用）；时间字段都取 now。 */
export function initialAxes(now = Date.now()) {
  return {
    at: Number(now) || 0,
    interaction_at: Number(now) || 0,
    axes: { ...REL_DEFAULTS },
    motion: zeroAxes(),
    bands: Object.fromEntries(AXIS_NAMES.map((k) => [k, 0])),
    day_key: '',
    repeats: 0,
    repeats_neg: 0,
    wobble_day: '',
    wobble: { p: 0, a: 0 },
  }
}

/** 把任意读回来的 JSON 洗成合法状态（缺字段补初值，不抛）。 */
export function normalizeState(raw, now = Date.now()) {
  const base = initialAxes(now)
  if (!raw || typeof raw !== 'object') return base
  const axes = {}
  for (const k of AXIS_NAMES) axes[k] = clamp01(raw?.axes?.[k] ?? REL_DEFAULTS[k])
  const bands = {}
  for (const k of AXIS_NAMES) {
    const b = Number(raw?.bands?.[k])
    bands[k] = Number.isFinite(b) ? Math.max(0, Math.min(3, Math.trunc(b))) : 0
  }
  const motion = {}
  for (const k of AXIS_NAMES) motion[k] = Math.max(0, Math.min(DAILY_MOTION_CAP, numOr(raw?.motion?.[k], 0)))
  return {
    at: numOr(raw.at, base.at),
    interaction_at: numOr(raw.interaction_at, numOr(raw.at, base.at)),
    axes,
    motion,
    bands,
    day_key: String(raw.day_key ?? ''),
    repeats: Math.max(0, Math.trunc(numOr(raw.repeats, 0))),
    repeats_neg: Math.max(0, Math.trunc(numOr(raw.repeats_neg, 0))),
    wobble_day: String(raw.wobble_day ?? ''),
    wobble: { p: numOr(raw?.wobble?.p, 0), a: numOr(raw?.wobble?.a, 0) },
  }
}

/**
 * 分档 + 滞回（Anima `_bands`）：上行要越过 阈值+0.035 才翻档，下行要跌破 阈值−0.035。
 * 无历史档位时直接用 raw（Anima 同口径：新角色第一轮没有滞后保护）。
 */
export function bandsOf(axes = {}, prevBands = null) {
  const prev = prevBands && typeof prevBands === 'object' ? prevBands : {}
  const out = {}
  for (const key of AXIS_NAMES) {
    const thresholds = key === 'tension' ? [0.15, 0.4, 0.7] : [0.25, 0.5, 0.75]
    const value = clamp01(axes?.[key])
    let raw = thresholds.filter((t) => value >= t).length
    const p = Number.isFinite(Number(prev[key])) ? Math.max(0, Math.min(3, Math.trunc(Number(prev[key])))) : raw
    if (raw > p && value < thresholds[raw - 1] + BAND_MARGIN) raw = p
    else if (raw < p && value >= thresholds[p - 1] - BAND_MARGIN) raw = p
    out[key] = raw
  }
  return out
}

/**
 * 纯读衰减（Anima `decayed`，只算不写）：
 * - tension 72h 半衰；
 * - warmth 长缺席回落到 0.6×familiarity（7 天宽限、35 天半衰），**只应用增量区段**，
 *   所以 `decay(decay(s,t1),t2)` 与 `decay(s,t2)` 逐位相等（时间分割不变）；
 * - at 只前进不后退（`max(now, at)`）；
 * - seed 存在时按本地日抽一次 wobble（wobble_day 幂等）。
 */
export function decayAxes(state, now = Date.now(), opts = {}) {
  const tz = opts.tz ?? DEFAULT_TZ
  const r = normalizeState(state, now)
  const nowN = Number(now) || r.at
  const hours = Math.max(0, nowN - r.at) / 3600
  const axes = r.axes
  axes.tension = clamp01(axes.tension * Math.pow(2, -hours / TENSION_HALF_LIFE_HOURS))

  const last = Number.isFinite(Number(r.interaction_at)) ? Number(r.interaction_at) : r.at
  const oldDays = Math.max(0, (r.at - last) / 86400 - ABSENCE_GRACE_DAYS)
  const newDays = Math.max(0, (Math.max(nowN, r.at) - last) / 86400 - ABSENCE_GRACE_DAYS)
  const anchor = axes.familiarity * FAMILIARITY_ANCHOR
  if (axes.warmth > anchor) {
    axes.warmth = clamp01(anchor + (axes.warmth - anchor) * Math.pow(2, -(newDays - oldDays) / WARMTH_HALF_LIFE_DAYS))
  }
  r.at = Math.max(nowN, r.at)

  if (opts.seed) {
    const day = localDayKey(r.at, tz)
    if (r.wobble_day !== day) {
      r.wobble = {
        p: Math.max(-1, Math.min(1, seededDaily(`${opts.seed}:${day}:p`) * 0.08)),
        a: Math.max(-1, Math.min(1, seededDaily(`${opts.seed}:${day}:a`) * 0.05)),
      }
      r.wobble_day = day
    }
  }
  r.bands = bandsOf(r.axes, r.bands)
  return r
}

/**
 * appraisal → 4 轴 units。
 * - 显式给 `trust/warmth/disclosure/tension`（Anima 的整数/小数口径）时直接用；
 * - 否则由我们的 `emotion/valence/arousal/intensity` 派生（本插件的 glue，不是 Anima 原逻辑）。
 */
export function unitsOf(raw = {}) {
  const fin = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const given = [fin(raw.trust), fin(raw.warmth), fin(raw.disclosure), fin(raw.tension)]
  if (given.some((x) => x !== null)) {
    return { trust: given[0] ?? 0, warmth: given[1] ?? 0, disclosure: given[2] ?? 0, tension: given[3] ?? 0 }
  }
  const i = clamp01(raw.intensity ?? 0)
  const v = Math.max(-1, Math.min(1, numOr(raw.valence, 0)))
  const emo = String(raw.emotion ?? '')
  let trust = v * i * 3
  let warmth = v * i * 3
  let tension = v < 0 ? -v * i * 3 : 0
  const DISCLOSE = /sadness|anxiety|loneliness|lonely|affection|concern|guilt|longing|fear|worried/
  let disclosure = DISCLOSE.test(emo) ? i * 3 : 0
  // 关心/担心：是靠近，不是受伤——不扣 trust、不加 tension。
  if (/concern|worried|worry/.test(emo)) {
    trust = 0
    warmth = i * 1.5
    tension = 0
    disclosure = i * 3
  }
  if (/anger|frustration|irritation|annoy/.test(emo)) {
    tension = Math.max(tension, i * 3)
    warmth = -i * 1.5
    trust = -i
  }
  if (/joy|affection|pride|gratitude|moved|relief|happy|amused/.test(emo)) {
    warmth = Math.max(warmth, i * 2.5)
    trust = Math.max(trust, i * 1.5)
  }
  return { trust, warmth, disclosure, tension }
}

/**
 * 推进一轮（Anima `advance` 的 4 轴版）。
 * 顺序与原文一致：先衰减 → 跨日重置 motion/repeats → 算乘子 → 逐轴 apply → 刷 interaction_at/repeats → 重算 bands。
 */
export function advanceAxes(state, appraisal = {}, now = Date.now(), opts = {}) {
  const tz = opts.tz ?? DEFAULT_TZ
  const r = decayAxes(state, now, { ...opts, tz })
  const day = localDayKey(r.at, tz)
  if (day !== r.day_key) {
    r.day_key = day
    r.motion = zeroAxes()
    r.repeats = 0
    r.repeats_neg = 0
  }
  const a = unitsOf(appraisal)
  const fam = r.axes.familiarity
  // 乘子链（Anima emotion.py:107-120）；warmth 负向额外套同一套重复折扣（我们的修正）
  const posWarmDiscount = 1 + 0.6 * r.repeats
  const negWarmDiscount = 1 + 0.6 * r.repeats_neg
  const changes = {
    trust: a.trust * (a.trust < 0 ? 3.5 * (1 + 0.6 * (1 - fam)) : 1),
    warmth: a.warmth > 0 ? a.warmth / posWarmDiscount : (a.warmth * 1.5) / negWarmDiscount,
    familiarity: a.disclosure * 0.9,
    tension: a.tension * (a.tension > 0 ? 2.2 : 1),
  }
  const perCallCap = Number.isFinite(Number(opts.perCallCap)) && Number(opts.perCallCap) > 0 ? Number(opts.perCallCap) : PER_CALL_CAP
  for (const key of AXIS_NAMES) {
    const units = Number(changes[key]) || 0
    const value = r.axes[key]
    let delta = units * AXIS_SCALE * (units > 0 ? 1 - 0.75 * value : 0.25 + 0.75 * value)
    if (Math.abs(delta) > perCallCap) delta = Math.sign(delta) * perCallCap
    const remaining = Math.max(0, DAILY_MOTION_CAP - r.motion[key])
    delta = Math.max(-remaining, Math.min(remaining, delta))
    const next = clamp01(value + delta)
    r.axes[key] = next
    r.motion[key] += Math.abs(next - value)
  }
  r.interaction_at = r.at
  if (a.warmth > 0) r.repeats += 1
  else if (a.warmth < 0) r.repeats_neg += 1
  r.bands = bandsOf(r.axes, r.bands)
  return r
}

/* ── 文案（六段，中文；与 Anima note() 同结构） ───────────────────── */

const FAMILIARITY_TEXT = ['还不太熟，别装作很熟', '正在熟起来', '已经彼此熟悉', '有一段很深的共同记忆']
const WARMTH_TEXT = ['温度轻一点，别太重', '淡淡的亲切刚好', '这份温暖是慢慢换来的', '亲近到这个程度，可以更软一点']
const TRUST_TEXT = ['先别默认有很深的信任', '信任还在建立中', '有换来的一点信任', '信任已经很深了']
const TENSION_TEXT = ['', '还有些没说开的别扭', '有真实的、没解决的紧绷', '张力不小，需要留出修复的空间，不追责、不施压']

/** 取档位（越界夹回 0..3）；未知返回 0。 */
const bandAt = (state, key) => {
  const b = Number(state?.bands?.[key])
  return Number.isFinite(b) ? Math.max(0, Math.min(3, Math.trunc(b))) : 0
}

/**
 * 关系底气行（零数字）：familiarity / warmth / trust / 基调 / tension（档 0 不写）/ 防御收尾。
 * @param {object} state relationship 状态（advanceAxes/decayAxes 的产物）
 * @param {{valence?:number, arousal?:number}} [mood] 当前情绪快层的 valence/arousal（可选，只用来选基调词）
 */
export function relationshipLine(state, mood = {}) {
  const s = normalizeState(state, Date.now())
  const fam = FAMILIARITY_TEXT[bandAt(s, 'familiarity')]
  const warm = WARMTH_TEXT[bandAt(s, 'warmth')]
  const trust = TRUST_TEXT[bandAt(s, 'trust')]
  const tension = TENSION_TEXT[bandAt(s, 'tension')]
  const v = numOr(mood.valence, 0)
  const a = numOr(mood.arousal, 0.2)
  let moodText = v < -0.15 ? '整体基调偏低' : '整体基调平稳'
  if (a > 0.25) moodText += '，语气里可以多一点精神'
  const parts = [fam, warm, trust, moodText]
  if (tension) parts.push(tension)
  return `【关系底色】${parts.join('；')}。${REL_DEFENSE}`
}

/* ── 持久化 ─────────────────────────────────────────── */

export const REL_TABLE_DDL = `CREATE TABLE IF NOT EXISTS relationship_axes (
  self_id TEXT NOT NULL,
  peer_id TEXT NOT NULL DEFAULT 'owner',
  axes_json TEXT NOT NULL DEFAULT '{}',
  bands_json TEXT NOT NULL DEFAULT '{}',
  motion_json TEXT NOT NULL DEFAULT '{}',
  day_key TEXT NOT NULL DEFAULT '',
  interaction_at INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(self_id, peer_id)
)`

export function ensureRelationshipTable(db) {
  try {
    db.exec(REL_TABLE_DDL)
    return true
  } catch {
    return false
  }
}

/** 该会话对应"谁"：显式 peerId/contactId > QQ 私聊目录名 > owner。 */
export function peerIdOf(header) {
  const h = header?.session?.header ?? header ?? {}
  const explicit = h?.peerId ?? h?.contactId
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) return String(explicit).trim().slice(0, 64)
  const cwd = String(h?.cwd ?? '').replaceAll('\\', '/')
  const m = /(?:^|\/)qq-(私聊|群)\/([^/]+)\/?$/.exec(cwd)
  if (m) return m[1] === '群' ? `group:${m[2]}` : String(m[2]).slice(0, 64)
  return DEFAULT_PEER
}

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(String(raw ?? ''))
    return v && typeof v === 'object' ? v : fallback
  } catch {
    return fallback
  }
}

/** 读一行 → 状态；无行/无表返回 null（不抛）。 */
export function loadRelationship(db, selfId, peerId = DEFAULT_PEER) {
  try {
    const row = db.prepare('SELECT * FROM relationship_axes WHERE self_id=? AND peer_id=?').get(String(selfId), String(peerId))
    if (!row) return null
    return normalizeState(
      {
        at: Number(row.at),
        interaction_at: Number(row.interaction_at),
        axes: parseJson(row.axes_json, {}),
        bands: parseJson(row.bands_json, {}),
        motion: parseJson(row.motion_json, {}),
        day_key: row.day_key,
      },
      Number(row.at) || Date.now(),
    )
  } catch {
    return null
  }
}

export function saveRelationship(db, selfId, peerId, state, now = Date.now()) {
  const s = normalizeState(state, now)
  db.prepare(
    `INSERT INTO relationship_axes(self_id,peer_id,axes_json,bands_json,motion_json,day_key,interaction_at,at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(self_id,peer_id) DO UPDATE SET
       axes_json=excluded.axes_json, bands_json=excluded.bands_json, motion_json=excluded.motion_json,
       day_key=excluded.day_key, interaction_at=excluded.interaction_at, at=excluded.at, updated_at=excluded.updated_at`,
  ).run(
    String(selfId),
    String(peerId ?? DEFAULT_PEER),
    JSON.stringify(s.axes),
    JSON.stringify(s.bands),
    JSON.stringify(s.motion),
    String(s.day_key ?? ''),
    Number(s.interaction_at) || 0,
    Number(s.at) || 0,
    Number(now) || 0,
  )
  return s
}

/** 只读预览：有行就按行衰减，没有就用初值；**不写库**。 */
export function relationshipOf(db, selfId, peerId = DEFAULT_PEER, now = Date.now(), opts = {}) {
  const row = loadRelationship(db, selfId, peerId)
  const base = row ?? initialAxes(now)
  if (row) return decayAxes(base, now, opts)
  const fresh = decayAxes(base, now, opts)
  // 首次预览也用本地日初始化 day_key，避免文案里出现"跨日重置"的边界差异
  if (!fresh.day_key) fresh.day_key = localDayKey(fresh.at, opts.tz ?? DEFAULT_TZ)
  return fresh
}

/**
 * 写路径：推进一轮并落库。任何失败都返回 null（绝不抛给调用方）。
 * @param {object} appraisal 至少含 emotion/intensity/valence，或显式 trust/warmth/disclosure/tension
 */
export function advanceRelationship(db, selfId, peerId, appraisal = {}, now = Date.now(), opts = {}) {
  try {
    if (!db || !selfId) return null
    ensureRelationshipTable(db)
    const prev = loadRelationship(db, selfId, peerId) ?? {
      ...initialAxes(now),
      day_key: localDayKey(now, opts.tz ?? DEFAULT_TZ),
    }
    const next = advanceAxes(prev, appraisal, now, opts)
    saveRelationship(db, selfId, peerId, next, now)
    return next
  } catch {
    return null
  }
}

/* ── attunement（intent/cue/uncertainty/avoid，不存 CoT） ───────────── */

export const ATTUNEMENT_INTENTS = ['listen', 'practical', 'answer', 'repair', 'space', 'playful', 'uncertain']
export const ATTUNEMENT_FIELD_MAX = 500
export const ATTUNEMENT_AVOID_MAX = 8

/** 宽松解析：非法 intent → ''（不抛）；长文本截断（结构上防 CoT）。 */
export function normalizeAttunement(raw) {
  if (!raw || typeof raw !== 'object') return null
  const intentRaw = String(raw.intent ?? '').trim()
  const intent = ATTUNEMENT_INTENTS.includes(intentRaw) ? intentRaw : ''
  const clip = (v, max = ATTUNEMENT_FIELD_MAX) => String(v ?? '').trim().slice(0, max)
  const avoid = Array.isArray(raw.avoid)
    ? raw.avoid
        .map((x) => clip(x, 80))
        .filter(Boolean)
        .slice(0, ATTUNEMENT_AVOID_MAX)
    : []
  const out = {
    intent,
    userCue: clip(raw.user_cue ?? raw.userCue),
    uncertainty: clip(raw.uncertainty),
    avoid,
  }
  if (!out.intent && !out.userCue && !out.uncertainty && !out.avoid.length) return null
  return out
}

/** 把 attunement 写回 emotion_appraisal 行（幂等 UPDATE；失败返回 null）。 */
export function writeAttunement(db, appraisalId, raw) {
  const a = normalizeAttunement(raw)
  const id = Number(appraisalId)
  if (!a || !db || !Number.isFinite(id) || id <= 0) return null
  try {
    db.prepare('UPDATE emotion_appraisal SET intent=?, user_cue=?, uncertainty=?, avoid_json=? WHERE id=?').run(
      a.intent,
      a.userCue,
      a.uncertainty,
      JSON.stringify(a.avoid),
      id,
    )
    return { ok: true, appraisalId: id, intent: a.intent, avoid: a.avoid.length }
  } catch {
    return null
  }
}

export const _internal = { clamp01, zeroAxes, AXIS_NAMES }
