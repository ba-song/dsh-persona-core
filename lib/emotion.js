/**
 * 情绪：词典打分、平滑、双衰减、转折点、溯源。
 * 规则与记忆插件现实现一致（k=0.45、6h/30min 半衰期、阈值 0.35），键改为 self_id。
 * 铁律：情绪不参与事实判定；注入只给标签与语气，不给数值。
 */
import { PersonaError, E, tx } from './db.js'

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

export const DEFAULTS = {
  k: 0.45,
  valenceHalfLifeHours: 6,
  arousalHalfLifeHours: 0.5,
  arousalBaseline: 0.2,
  pointThreshold: 0.15,
  injectThreshold: 0.35,
  triggerMaxChars: 60,
  auditSampleRate: 5,
  lowConfidence: 0.35,
  questionWeight: 0.25,
  selfWeight: 0.3,
  ownerFatigueIgnore: true,
  // 2026-11-12：mood 慢层 + dominance（参考 FAtiMA/ALMA）
  moodEnabled: true,
  moodHalfLifeHours: 48,
  moodPushThreshold: 0.5,
  dominanceHalfLifeHours: 72,
  dominanceBaseline: 0.5,
  // 2026-11-12 P0（AstrBot memory-brain 情绪层）：
  // 单条消息对 valence/arousal/dominance 的变化上限，避免一条消息从平静跳到暴怒；
  // 标签半衰期：episode 标签按 45min 半衰期衰减，超过一个半衰期回落到 valence。
  maxDeltaPerMessage: 0.12,
  labelHalfLifeMinutes: 45,
}

const LEXICON = {
  棒: 0.7, 好: 0.5, 开心: 0.8, 谢谢: 0.6, 快: 0.4, 漂亮: 0.6, 喜欢: 0.7, 顺利: 0.6, 赞: 0.7,
  崩: -0.8, 烦: -0.7, 烂: -0.8, 垃圾: -0.8, 失望: -0.7, 慢: -0.4, 错: -0.5, 丢: -0.6,
  高兴: 0.8, 快乐: 0.8, 幸福: 0.8, 满足: 0.6, 舒服: 0.5, 温暖: 0.6, 可爱: 0.6, 心动: 0.7,
  惊喜: 0.8, 期待: 0.5, 安心: 0.5, 踏实: 0.5, 得意: 0.6, 骄傲: 0.6, 轻松: 0.4, 甜: 0.6,
  笑: 0.5, 哈哈: 0.5, 夸奖: 0.7, 表扬: 0.7, 成功: 0.7, 赢了: 0.7, 太好了: 0.8, 真棒: 0.8,
  难过: -0.8, 伤心: -0.8, 委屈: -0.7, 生气: -0.8, 愤怒: -0.9, 讨厌: -0.8, 烦人: -0.7,
  害怕: -0.6, 担心: -0.4, 焦虑: -0.6, 紧张: -0.4, 累: -0.4, 疲惫: -0.5, 困: -0.3,
  孤单: -0.6, 寂寞: -0.5, 想哭: -0.8, 哭: -0.7, 疼: -0.6, 痛: -0.6, 生病: -0.6,
  失败: -0.7, 搞砸: -0.8, 糟糕: -0.8, 倒霉: -0.6, 后悔: -0.6, 内疚: -0.6, 尴尬: -0.4,
  无聊: -0.3, 冷淡: -0.4, 敷衍: -0.5, 忽略: -0.5, 凶: -0.6, 吵: -0.4, 误会: -0.5,
  崩溃: -0.9, 绝望: -0.9, 麻木: -0.3, 平静: 0, 一般: 0, 还行: 0.1, 普通: 0,
  气死: -0.9, 烦死: -0.8, 无语: -0.5, 可恶: -0.7, 气人: -0.7, 受够: -0.8, 火大: -0.8,
  笑死: 0.8, 爱你: 0.9, 想你: 0.8, 抱抱: 0.7, 亲亲: 0.8, 心疼: -0.4, 感动: 0.7,
}

const IRONY = ['呵呵', '真是', '可真是', '真行', '服了', '谢谢你啊', '是吧', '呢~', '哦']
const AROUSAL_BOOST = ['太', '超', '特别', '非常', '真的', '好想', '！！', '!!', '呜呜', '啊啊', '救命']

/**
 * 标签集合（2026-11-12 P0，参考 AstrBot memory-brain 情绪层「PAD + 标签」）：
 * - 11 个规范标签：10 个情绪标签 + 平静；
 * - 3 个历史标签（兴奋/低落/疲惫）保留兼容：旧库行、旧注入文本和 labelOf 的两参数
 *   旧口径仍会产出它们，`TONE` 也必须能给出语气，否则会静默回落到「平静」。
 * 约束：TONE 覆盖 LABELS 全集；composeEmotionView 的 emotion→标签映射只产出 LABELS 里的值。
 */
export const CANONICAL_LABELS = ['开心', '生气', '难过', '害怕', '委屈', '害羞', '得意', '感动', '焦虑', '无聊', '平静']
export const LEGACY_LABELS = ['兴奋', '低落', '疲惫']
export const LABELS = [...CANONICAL_LABELS, ...LEGACY_LABELS]

const TONE = {
  开心: '更轻快，愿意多聊两句',
  兴奋: '话会多一点，容易接梗',
  难过: '话偏少，别太闹',
  低落: '安静一些，不太想玩',
  生气: '别惹她，语气会冲',
  焦虑: '有点不安，容易想多',
  疲惫: '懒懒的，别安排太多',
  平静: '和平时差不多',
  害怕: '有点发怵，别逼她',
  委屈: '语气会软，想被哄一下',
  害羞: '话短一点，不太敢直说',
  得意: '有点小骄傲，会显摆',
  感动: '语气会软，记得这份好',
  无聊: '提不起劲，回得慢',
}

/**
 * appraisal / 自述的 emotion 代码 → 中文标签（唯一映射表）。
 * 值必须在 LABELS 里；缺失时回落到 state.label（同样过一遍白名单）。
 * 「补齐」口径：代码里出现过的所有 emotion 代码都要有映射，避免注入时语气回落成平静。
 */
export const EMOTION_LABELS = {
  joy: '开心',
  pride: '得意',
  affection: '感动',
  relief: '平静',
  frustration: '生气',
  sadness: '难过',
  anger: '生气',
  anxiety: '焦虑',
  fear: '害怕',
  worry: '焦虑',
  concern: '焦虑',
  nervous: '焦虑',
  loneliness: '难过',
  shy: '害羞',
  shyness: '害羞',
  embarrassment: '害羞',
  moved: '感动',
  gratitude: '感动',
  boredom: '无聊',
  injustice: '委屈',
  aggrieved: '委屈',
  fatigue: '疲惫',
  calm: '平静',
  // 2026-11-13：19 种特殊情绪代码（映射到 11 个规范标签，不新增注入标签）
  gratitude: '感动',
  guilt: '难过',
  regret: '难过',
  jealousy: '生气',
  longing: '难过',
  disappointment: '难过',
  anticipation: '开心',
  reassurance: '平静',
  irritation: '生气',
  emptiness: '无聊',
  happiness: '开心',
  sadness_deep: '难过',
  shame: '害羞',
}
/** 19 种特殊情绪（素材视频 175718）：代码 → 标签；只作归一化映射，不改状态机。 */
export const SPECIAL_EMOTIONS = ['joy','pride','affection','gratitude','relief','calm','anger','frustration','sadness','grief','fear','anxiety','shy','embarrassment','moved','jealousy','guilt','longing','boredom','anticipation','disappointment','reassurance']


/** 注入硬约束（要求 4）：情绪只影响语气，不能拿它当筹码。只出现一次。 */
export const EMOTION_RULE = '情绪只影响语气，不影响判断，不能拿情绪拿捏对方。'
/** 完整情绪行上限（字）：含规则句；超长只压语气。 */
export const EMOTION_LINE_MAX = 60

/** emotion 代码 → 标签；未知代码回落到当前标签，仍不在白名单则「平静」。 */
export function labelForEmotion(emotion, fallback = '平静') {
  const hit = EMOTION_LABELS[String(emotion ?? '')]
  if (hit) return hit
  const fb = String(fallback ?? '')
  return LABELS.includes(fb) ? fb : '平静'
}

/** 注入排除：运行时上下文、本插件与记忆插件的注入块、系统提示。 */
export const EXCLUDE_PREFIX = [
  '【记忆·',
  '【本轮相关】',
  '【相关原话】',
  '【人格核心',
  '【你现在的情绪】',
  '【事实卡',
  'Current runtime context',
  'Current DSH file policy',
  'Current working directory',
  'Time sampled',
  'Browser time zone',
  'Elapsed since',
  'SCHEDULE REMINDER',
  '<system>',
  '<system-reminder',
  '【这个房间的规矩】',
  '# 这是你的 QQ 房间',
  '# 家里的小纸条',
  '# 汐项目 · 全体工作 Agent 通用守则',
  '[tool result]',
  'tool_result',
  '工具结果',
  '[QQ·',
  '[SILENT]',
]

export function isPolluted(text) {
  const s = String(text ?? '')
  return EXCLUDE_PREFIX.some((p) => s.includes(p))
}

/**
 * 否定词：只在直接修饰情绪词时生效。
 * 复合词里的字（特别/无比/忍不住/非常…）不算否定——否则「特别开心」会被读成负分。
 */
const NEGATION_CHARS = new Set(['不', '没', '别', '未', '无', '非'])
const NEGATION_COMPOUNDS = [
  '特别', '别人', '别的', '别处', '无比', '无论', '无数', '不同', '不断', '不仅', '不管', '不论',
  '不然', '不得了', '不过', '不错', '忍不住', '不由得', '不禁', '差不多', '对不起', '非常', '未来',
]
/** 短语级词条（先于单字匹配，避免「不错」被里面的「错」打成负分）。 */
const PHRASE_LEXICON = { 不错: 0.5 }
const LEXICON_ENTRIES = Object.entries({ ...LEXICON, ...PHRASE_LEXICON }).sort((a, b) => b[0].length - a[0].length)
const NEGATION_WINDOW = 6
const CLAUSE_STOP = new Set([...'，。！？；、,.!?;：:…—~～ \n\r\t"\'“”‘’()（）'])
const HINT_WORDS = ['疲惫', '没力气', '撑不住', '累', '困']

/** 把复合词覆盖到的字标记出来：这些位置上的「不/没/别/无/非」不当否定。 */
function protectedMask(text) {
  const mask = new Uint8Array(text.length)
  for (const word of NEGATION_COMPOUNDS) {
    let at = text.indexOf(word)
    while (at >= 0) {
      for (let i = at; i < at + word.length; i++) mask[i] = 1
      at = text.indexOf(word, at + 1)
    }
  }
  return mask
}

/** 情绪词前 6 字内、同一小句里的否定次数（复合词里的字不算）。 */
function negationCount(text, start, mask) {
  let count = 0
  for (let i = start - 1; i >= 0 && i >= start - NEGATION_WINDOW; i--) {
    const ch = text[i]
    if (CLAUSE_STOP.has(ch)) break
    if (NEGATION_CHARS.has(ch) && !mask[i]) count += 1
  }
  return count
}

/** 单否定：正→负（原强度）、负→轻微正（0.3 倍）；双否定：原方向半强度。 */
function negateDelta(delta, count) {
  if (!count) return delta
  if (count % 2 === 1) return delta > 0 ? -delta : Math.abs(delta) * 0.3
  return delta * 0.5
}

/** 疲惫提示：紧贴否定词时不算（不累/不困/不疲惫），「没力气/撑不住」本身算。 */
function hintOf(text) {
  for (const word of HINT_WORDS) {
    let at = text.indexOf(word)
    while (at >= 0) {
      const prev = at > 0 ? text[at - 1] : ''
      if (!NEGATION_CHARS.has(prev)) return '疲惫'
      at = text.indexOf(word, at + 1)
    }
  }
  return null
}

/**
 * 词典打分（长词优先、同一段只计一次）+ 否定翻转 + 反讽降置信。
 * 纯函数：不剥前缀、不写库；调用方（ingestEmotion）负责先剥前缀。
 */
export function scoreText(text) {
  const s = String(text ?? '')
  const mask = protectedMask(s)

  // 长词优先扫描：命中「太好了」就不再计里面的「好」，避免重复计分。
  const matches = []
  let i = 0
  while (i < s.length) {
    const hit = LEXICON_ENTRIES.find(([w]) => s.startsWith(w, i))
    if (hit) {
      matches.push({ delta: hit[1], index: i })
      i += hit[0].length
    } else i += 1
  }
  const hits = matches.length
  let v = 0
  for (const m of matches) v += negateDelta(m.delta, negationCount(s, m.index, mask))

  let arousal = 0.2
  for (const w of AROUSAL_BOOST) if (s.includes(w)) arousal += 0.15
  if (/[！!]{2,}|[？?]{2,}/.test(s)) arousal += 0.1
  const rawV = hits ? Math.abs(v / (hits >= 2 ? 3 : 2)) : 0
  arousal = clamp(arousal + Math.min(0.5, hits * 0.12) + rawV * 0.15, 0, 1)
  const irony = IRONY.some((m) => s.includes(m))
  const hint = hintOf(s)
  if (!hits) return { valence: 0, arousal: 0.2, confidence: 0.2, hits: 0, irony, hint }
  const val = clamp(v / (hits >= 2 ? 3 : 2), -1, 1)
  const confidence = clamp(0.55 + hits * 0.08 - (irony ? 0.2 : 0), 0, 1)
  return { valence: val, arousal, confidence, hits, irony, hint }
}

/**
 * 标签判定。
 * - 两参数（旧口径，兼容）：平静/开心/兴奋/难过/生气/焦虑/低落，行为与 2026-11 之前一致；
 * - 三参数（PAD，传 dominance）：按 valence/arousal/dominance 出 11 个规范标签，
 *   兴奋/低落作为历史标签仍可能兜底出现。
 * 返回值恒在 LABELS 内（测试兜底；否则注入语气会回落到「平静」）。
 */
export function labelOf(valence, arousal, dominance = null) {
  const v = Number(valence) || 0
  const a = Number(arousal ?? 0.2)
  if (Math.abs(v) < 0.15 && a < 0.45) return '平静'
  const d = dominance === null || dominance === undefined || dominance === '' ? null : Number(dominance)
  if (d === null || !Number.isFinite(d)) return legacyLabelOf(v, a)
  return padLabelOf(v, a, clamp(d, 0, 1))
}

/** 旧两参数口径：保持历史输出不变（老调用方/老测试兼容）。 */
function legacyLabelOf(v, a) {
  if (v >= 0.15) return a >= 0.6 ? '兴奋' : '开心'
  if (v <= -0.45) return a >= 0.6 ? '生气' : '难过'
  return a >= 0.55 ? '焦虑' : '低落'
}

/**
 * PAD 三维口径（要求 2）：
 * - dominance 低 = 主导感弱（害怕/委屈/害羞），高 = 得意；
 * - 低唤醒 + 轻微负向 = 无聊；强正向 + 低唤醒 = 感动（被暖到）；
 * - 兴奋/低落作为历史标签保留兜底，避免旧数据断档。
 */
function padLabelOf(v, a, d) {
  if (v >= 0.15) {
    if (a >= 0.55 && d <= 0.35 && v < 0.45) return '害羞'
    if (a >= 0.6) return d >= 0.65 ? '得意' : '兴奋'
    if (a < 0.3 && v >= 0.45) return '感动'
    if (d >= 0.65) return '得意'
    return '开心'
  }
  if (a >= 0.55) {
    if (d <= 0.35) return '害怕'
    return v <= -0.45 ? '生气' : '焦虑'
  }
  if (v <= -0.45) return d <= 0.3 ? '委屈' : '难过'
  if (d <= 0.3) return '委屈'
  if (a < 0.4 && v > -0.35) return '无聊'
  return '低落'
}

/**
 * 单次变化上限（要求 1）：把 next 相对 base 的变化夹在 ±maxDelta 内。
 * maxDelta 非法/≤0 时用默认值——限速不能被配置失手关掉（否则一条消息就能暴怒）。
 */
export function capDelta(base, next, maxDelta = DEFAULTS.maxDeltaPerMessage) {
  const baseN = Number(base) || 0
  const nextN = Number(next) || 0
  const raw = Number(maxDelta)
  const cap = Number.isFinite(raw) && raw > 0 ? raw : DEFAULTS.maxDeltaPerMessage
  const delta = nextN - baseN
  if (Math.abs(delta) <= cap) return nextN
  return baseN + Math.sign(delta) * cap
}

export function intensityOf(valence, arousal) {
  return Math.max(Math.abs(valence), Number(arousal ?? 0))
}

/** 惰性衰减：只算不写库。 */
export function decayState(state, now = Date.now(), opts = DEFAULTS) {
  const hours = Math.max(0, (now - Number(state?.updated_at ?? state?.updatedAt ?? now)) / 3600000)
  const v = Number(state?.valence ?? 0) * Math.pow(0.5, hours / opts.valenceHalfLifeHours)
  const baseline = Number(opts.arousalBaseline ?? 0.2)
  const a = baseline + (Number(state?.arousal ?? baseline) - baseline) * Math.pow(0.5, hours / opts.arousalHalfLifeHours)
  const ess = homeostasisAt(state, now)
  const moodV = Number(state?.mood_valence ?? 0) * Math.pow(0.5, hours / Number(opts.moodHalfLifeHours ?? 48))
  const moodA = 0.2 + (Number(state?.mood_arousal ?? 0.2) - 0.2) * Math.pow(0.5, hours / Number(opts.moodHalfLifeHours ?? 48))
  const dom = clamp(
    Number(opts.dominanceBaseline ?? 0.5) +
      (Number(state?.dominance ?? 0.5) - Number(opts.dominanceBaseline ?? 0.5)) *
        Math.pow(0.5, hours / Number(opts.dominanceHalfLifeHours ?? 72)),
    0,
    1,
  )
  const blended = clamp(v * 0.7 + moodV * 0.3, -1, 1)
  return {
    valence: v,
    arousal: a,
    certainty: Number(state?.certainty ?? 0.5),
    label: labelOf(blended, a, dom),
    intensity: intensityOf(blended, a),
    energy: ess.energy,
    social: ess.social,
    dominance: dom,
    moodValence: moodV,
    moodArousal: moodA,
    moodUpdatedAt: Number(state?.mood_updated_at ?? 0),
    // 标签新鲜度时钟：episode 标签的半衰期（要求 3）从这里起算
    labelUpdatedAt: Number(state?.label_updated_at ?? 0),
    updatedAt: Number(state?.updated_at ?? state?.updatedAt ?? 0),
  }
}

export function nextState(prev, score, now = Date.now(), opts = DEFAULTS) {
  const k = opts.k
  const baseV = Number(prev?.valence ?? 0)
  const baseA = Number(prev?.arousal ?? opts.arousalBaseline)
  const maxDelta = Number(opts.maxDeltaPerMessage ?? DEFAULTS.maxDeltaPerMessage)
  // 要求 1：先按 k 平滑，再把单条消息的变化压到 ±maxDeltaPerMessage
  const valence = capDelta(baseV, clamp(baseV * (1 - k) + score.valence * k, -1, 1), maxDelta)
  const arousal = capDelta(baseA, clamp(baseA * (1 - k) + score.arousal * k, 0, 1), maxDelta)
  const hintLabel = score.hint && Math.abs(valence) < 0.35 ? score.hint : null
  const certainty = clamp(0.7 * Number(prev?.certainty ?? 0.5) + 0.3 * Number(score.confidence ?? 0.5), 0, 1)
  const dom = Number(prev?.dominance)
  return {
    valence,
    arousal,
    certainty,
    label: hintLabel || labelOf(valence, arousal, Number.isFinite(dom) ? dom : null),
    intensity: intensityOf(valence, arousal),
    confidence: Number(score.confidence ?? 0),
    source: 'rule',
    updatedAt: now,
  }
}

function neutral() {
  return { valence: 0, arousal: 0.2, certainty: 0.5, label: '平静', intensity: 0.2, confidence: 0, source: 'init', updatedAt: 0 }
}

export function ensureState(db, selfId) {
  const row = db.prepare('SELECT * FROM emotion_state WHERE self_id=?').get(selfId)
  if (row) return row
  const at = Date.now()
  db.prepare(
    `INSERT INTO emotion_state(self_id,valence,arousal,certainty,label,intensity,confidence,source,energy,social,ess_updated_at,label_updated_at,updated_at)
     VALUES(?,0,0.2,0.5,'平静',0.2,0,'init',0.7,0.7,?,?,?)`,
  ).run(selfId, at, at, at)
  return db.prepare('SELECT * FROM emotion_state WHERE self_id=?').get(selfId)
}

export function loadState(db, selfId) {
  return db.prepare('SELECT * FROM emotion_state WHERE self_id=?').get(selfId) ?? neutral()
}

export function currentState(db, selfId, now = Date.now(), opts = DEFAULTS) {
  return decayState(loadState(db, selfId), now, opts)
}

export function masked(text, maxChars) {
  // 0 / 负数 / 非数字 = 不存 trigger（只留 msg_ref）；默认调用方给 60。
  const limit = Number(maxChars)
  if (!Number.isFinite(limit) || limit <= 0) return ''
  let s = String(text ?? '').replace(/\s+/g, ' ').trim()
  s = s.replace(/1[3-9]\d{9}/g, '（已省略）').replace(/\b\d{6,}\b/g, '（已省略）')
  return s.slice(0, limit)
}

const TIME_PREFIX_RE = /^\[(?:现在是|当前时间|现在时间)[^\[\]]{0,120}\]\s*/
const SPEAKER_TAG_RE = /^\[[^\[\]]{1,60}\]\s*/
const QQ_HEADER_RE = /^\[QQ[^\[\]]{0,200}\]\s*/
const RECALL_TAG_RE = /^\[补收·[^\[\]]{0,30}\]\s*/
const ROOM_RULES_MARKER = '【这个房间的规矩】'
const RUNTIME_MARKER = 'Current runtime context'
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi
const SYSTEM_TAG_RE = /<system>[\s\S]*?<\/system>/gi
const AGENTS_HEADINGS = ['# 汐项目 · 全体工作 Agent 通用守则', '# 这是你的 QQ 房间', '# 家里的小纸条', '# 这个房间的规矩']
const TOOL_ECHO_MARKERS = ['[tool result]', '[工具结果]', '工具结果', 'tool_result']

/**
 * 剥掉/切断「不是她的话」的前缀与系统块，再拿去打分：
 * - 渠道头 `[QQ·私聊·…]`、补收标记、时间前缀、说话人标签；
 * - `<system-reminder>…</system-reminder>` / `<system>…</system>` 整块删除；
 * - `Current runtime context` 及之后（运行时上下文）丢弃；
 * - 房间规矩 `【这个房间的规矩】` 及其后（桥注入的规则块）丢弃；
 * - AGENTS 注入标题（QQ 房间/家里的小纸条/总守则）及之后丢弃；
 * - 工具结果回显标记及之后丢弃。
 * 只剥「系统拼进来的部分」，用户原话保留（例如 [QQ·…] 后面的话）。
 */
export function stripPromptPrefixes(text) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim()
  // 运行时上下文：整段不是她的话，丢弃标记及之后
  const runtimeAt = s.indexOf(RUNTIME_MARKER)
  if (runtimeAt >= 0) s = s.slice(0, runtimeAt)
  s = s.replace(SYSTEM_REMINDER_RE, ' ').replace(SYSTEM_TAG_RE, ' ')
  // 房间规矩块：桥附加在用户消息尾部，截断到标记前
  const rulesAt = s.indexOf(ROOM_RULES_MARKER)
  if (rulesAt >= 0) s = s.slice(0, rulesAt)
  // AGENTS 注入块：整段丢弃
  for (const h of AGENTS_HEADINGS) {
    const i = s.indexOf(h)
    if (i >= 0) {
      s = s.slice(0, i)
      break
    }
  }
  // 工具结果回显：截断到标记前
  for (const m of TOOL_ECHO_MARKERS) {
    const i = s.indexOf(m)
    if (i >= 0) {
      s = s.slice(0, i)
      break
    }
  }
  // 前导标签：时间 / QQ 房间头 / 补收标记（可连续）
  let hadTime = false
  for (;;) {
    let m = TIME_PREFIX_RE.exec(s)
    if (m) {
      s = s.slice(m[0].length)
      hadTime = true
      continue
    }
    m = QQ_HEADER_RE.exec(s)
    if (m) {
      s = s.slice(m[0].length)
      continue
    }
    m = RECALL_TAG_RE.exec(s)
    if (m) {
      s = s.slice(m[0].length)
      continue
    }
    break
  }
  if (hadTime) {
    const m = SPEAKER_TAG_RE.exec(s)
    if (m) s = s.slice(m[0].length)
  }
  return s.trim()
}

/**
 * 主人疲惫词（临时止血）：只从主人的 user 消息里剔除，不让她因为主人说累而「疲惫」。
 * 长词在前，避免「没力气」被「力气」类规则误伤；全部替换为空串。
 */
export const OWNER_FATIGUE_WORDS = ['没力气', '撑不住', '疲惫', '熬夜', '累', '困', '乏']
const OWNER_FATIGUE_RE = new RegExp(OWNER_FATIGUE_WORDS.join('|'))

/**
 * 主人疲惫词剔除：含疲惫词的分句整句丢弃，保留其它分句（避免「我好累」剩下「好」反而加分）。
 * 例：「我好累，但是今天很开心」→「但是今天很开心」（保留开心）；「你困了嘛」→ 空。
 */
export function stripOwnerFatigue(text) {
  const s = String(text ?? '')
  if (!OWNER_FATIGUE_RE.test(s)) return s
  return s
    .split(/[，,。.！!？?；;、\n]+/)
    .filter((part) => part.trim() && !OWNER_FATIGUE_RE.test(part))
    .join(' ')
}

/** 主人疲惫 → 她的 concern episode（P0-A，临时最小实现）。 */
export const CONCERN_HALF_LIFE_S = 7200
export const CONCERN_CAUSE = '主人累了'
const CONCERN_BASE = { 没力气: 0.5, 撑不住: 0.55, 疲惫: 0.5, 熬夜: 0.45, 累: 0.35, 困: 0.35, 乏: 0.35 }

function negatedBefore(text, index) {
  return /[不没别未无]/.test(text.slice(Math.max(0, index - 4), index))
}

/**
 * 主人消息里的疲惫词 → concern 强度（0.35–0.6），按词强度和程度词。
 * 否定（我不累/我不困/没觉得累）不算；问句仍算（她可以关心）。
 */
export function detectOwnerFatigue(text) {
  const s = String(text ?? '')
  let best = null
  for (const [word, base] of Object.entries(CONCERN_BASE)) {
    let at = s.indexOf(word)
    while (at >= 0) {
      if (!negatedBefore(s, at)) {
        const around = s.slice(Math.max(0, at - 3), Math.min(s.length, at + word.length + 3))
        let intensity = base
        if (/(?:很|好|太|特别|非常|超级|真的|快)/.test(around)) intensity += 0.1
        if (/(?:有点|稍微|一点)/.test(around)) intensity -= 0.05
        intensity = clamp(intensity, 0.35, 0.6)
        if (!best || intensity > best.intensity) best = { intensity, cause: CONCERN_CAUSE, target: 'owner', word }
      }
      at = s.indexOf(word, at + 1)
    }
  }
  return best
}

/**
 * 精力/社交电量（P0-B，最小 homeostasis）：纯函数，不写库。
 * energy：北京时间 00–08 每小时 +0.05，其余 +0.015；交互 -0.005；floor 0.2。
 * 距上次 >6h 时按「睡了一觉」把 energy 至少抬到 0.55（不拉满）；social 每小 -0.01，cap 0.95。
 */
export const ENERGY_FLOOR = 0.2
export const SOCIAL_CAP = 0.95
export const SLEEP_GAP_HOURS = 6
export const SLEEP_MIN_ENERGY = 0.55

export function homeostasisAt(state, now = Date.now()) {
  const from = Number(state?.ess_updated_at || state?.updated_at || now)
  const hours = Math.max(0, (now - from) / 3600000)
  let energy = Number(state?.energy ?? 0.7)
  let t = from
  let guard = 0
  while (t < now && guard < 4000) {
    const next = Math.min(now, (Math.floor(t / 3600000) + 1) * 3600000)
    const hour = ((Math.floor(t / 3600000) + 8) % 24 + 24) % 24
    // 夜间 00–08 恢复更快；白天也至少回到 0.015/h
    energy += (hour >= 0 && hour < 8 ? 0.05 : 0.015) * ((next - t) / 3600000)
    t = next
    guard += 1
  }
  // 跨夜/长间隔：至少回到 0.55（睡了一觉），但不无条件拉满
  if (hours > SLEEP_GAP_HOURS) energy = Math.max(energy, SLEEP_MIN_ENERGY)
  const social = Number(state?.social ?? 0.7) - 0.01 * hours
  return { energy: clamp(energy, ENERGY_FLOOR, 1), social: clamp(social, 0.1, SOCIAL_CAP) }
}

/** 每次交互：energy -0.005；有正向互动时 social +0.02；写回 energy/social/ess_updated_at。 */
export function applyHomeostasis(db, selfId, at = Date.now(), { positive = false } = {}) {
  const row = loadState(db, selfId)
  const from = Number(row?.ess_updated_at || row?.updated_at || at)
  const longGap = (at - from) / 3600000 > SLEEP_GAP_HOURS
  const base = homeostasisAt(row, at)
  let energy = clamp(base.energy - 0.005, ENERGY_FLOOR, 1)
  // 长间隔后的首次交互也保证「起床恢复」至少 0.55（交互消耗不把它扣到线下）
  if (longGap) energy = Math.max(energy, SLEEP_MIN_ENERGY)
  const social = clamp(base.social + (positive ? 0.02 : 0), 0.1, SOCIAL_CAP)
  db.prepare('UPDATE emotion_state SET energy=?, social=?, ess_updated_at=? WHERE self_id=?').run(energy, social, at, selfId)
  return { energy, social }
}

/** 通用事件/评估/情绪 episode（P1a）：一次规则产出三行，episode 复用 P0 表。 */
export function recordEvent(db, selfId, { at = Date.now(), kind, actor = '', subject = '', target = '', goal = '', goalCongruence = 0, certainty = 0.5, novelty = 0.5, sourceRef = '', excerpt = '', payload = {}, confidence = 0.5 } = {}) {
  const info = db
    .prepare(
      'INSERT INTO emotion_event(self_id,at,kind,actor,subject,target,goal,goal_congruence,certainty,novelty,source_ref,excerpt,payload_json,confidence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(selfId, at, kind, actor, subject, target, goal, goalCongruence, certainty, novelty, sourceRef, String(excerpt ?? '').slice(0, 200), JSON.stringify(payload ?? {}), confidence)
  return Number(info.lastInsertRowid)
}

export function recordAppraisal(db, selfId, { eventId = 0, at = Date.now(), ruleId, emotion, intensity, valence = 0, arousal = 0.2, cause = '', target = '', confidence = 0.5, accepted = 1, source = 'rule' } = {}) {
  const info = db
    .prepare(
      'INSERT INTO emotion_appraisal(event_id,self_id,at,rule_id,emotion,intensity,valence,arousal,cause,target,confidence,accepted,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(eventId, selfId, at, ruleId, emotion, intensity, valence, arousal, cause, target, confidence, accepted, source)
  return Number(info.lastInsertRowid)
}

export function recordEpisode(db, selfId, { at = Date.now(), emotion, intensity, cause, target, halfLifeS, msgRef = '', appraisalId = 0 } = {}) {
  const expiresAt = at + Number(halfLifeS) * 1000 * 2
  db.prepare(
    'INSERT INTO emotion_episodes(self_id,at,emotion,intensity,cause,target,half_life_s,expires_at,appraisal_id,msg_ref) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(selfId, at, emotion, intensity, cause, target, halfLifeS, expiresAt, appraisalId, String(msgRef ?? ''))
  return { emotion, intensity, cause, target, at, expiresAt, halfLifeS }
}

/**
 * 把一次 appraisal 的 valence/arousal 写进核心状态（2026-11-13）。
 * 与 ingestEmotion 的区别：不跑词表、不猜，只吃评估结果；单条变化仍受 0.12 限速。
 */
export function applyCoreAppraisal(db, selfId, { at = Date.now(), valence = 0, arousal = 0.2, intensity = 0.5, label = '', cause = '', msgRef = '', opts = DEFAULTS } = {}) {
  ensureState(db, selfId)
  const row = loadState(db, selfId)
  const prev = decayState(row, at, opts)
  const baseV = Number.isFinite(Number(prev.valence)) ? Number(prev.valence) : 0
  const baseA = Number.isFinite(Number(prev.arousal)) ? Number(prev.arousal) : 0.2
  const vTarget = clamp(baseV + Number(valence) * Math.max(0.1, Number(intensity) || 0.5) * 0.45, -1, 1)
  const aTarget = clamp(baseA + (Number(arousal) - 0.2) * Math.max(0.1, Number(intensity) || 0.5) * 0.45, 0, 1)
  const v = capDelta(baseV, vTarget, opts.maxDeltaPerMessage)
  const a = capDelta(baseA, aTarget, opts.maxDeltaPerMessage)
  const lbl = label || labelOf(v, a)
  const inten = intensityOf(v, a)
  db.prepare('UPDATE emotion_state SET valence=?, arousal=?, label=?, intensity=?, label_updated_at=?, updated_at=? WHERE self_id=?')
    .run(v, a, lbl, inten, Number(at), Number(at), String(selfId))
  try {
    db.prepare('INSERT INTO emotion_timeline(session_key,valence,arousal,label,intensity,trigger,at) VALUES(?,?,?,?,?,?,?)')
      .run(String(selfId), v, a, lbl, inten, String(cause || '').slice(0, 120), Number(at))
  } catch {}
  return { valence: v, arousal: a, label: lbl, intensity: inten }
}

/** 规则 → event + appraisal + episode 一次写齐。 */
export function recordRuleEpisode(db, selfId, o = {}) {
  const at = Number(o.at ?? Date.now())
  const eventId = recordEvent(db, selfId, {
    at,
    kind: o.kind,
    actor: o.actor,
    subject: o.subject,
    target: o.target,
    goal: o.goal ?? '',
    goalCongruence: o.goalCongruence ?? 0,
    certainty: o.certainty ?? 0.8,
    novelty: o.novelty ?? 0.5,
    sourceRef: o.sourceRef ?? o.msgRef ?? '',
    excerpt: o.excerpt,
    payload: o.payload,
    confidence: o.confidence ?? 0.7,
  })
  const appraisalId = recordAppraisal(db, selfId, {
    eventId,
    at,
    ruleId: o.ruleId,
    emotion: o.emotion,
    intensity: o.intensity,
    valence: o.valence ?? 0,
    arousal: o.arousal ?? 0.2,
    cause: o.cause,
    target: o.episodeTarget ?? o.target,
    confidence: o.confidence ?? 0.7,
    accepted: 1,
    source: 'rule',
  })
  const episode = recordEpisode(db, selfId, {
    at,
    emotion: o.emotion,
    intensity: o.intensity,
    cause: o.cause,
    target: o.episodeTarget ?? o.target,
    halfLifeS: o.halfLifeS,
    msgRef: o.msgRef,
    appraisalId,
  })
  let state = null
  try {
    state = applyAppraisalToState(db, selfId, {
      at,
      emotion: o.emotion,
      intensity: o.intensity,
      valence: o.valence ?? 0,
      arousal: o.arousal ?? 0.2,
      ruleId: o.ruleId,
    })
  } catch {}
  // 2026-11-13：显式评估（LLM/规则给了 valence）时，同时写核心 valence/arousal；
  // 不再让 episode 和 state 两套账脱节。
  let core = null
  if (o.valence !== undefined || o.arousal !== undefined) {
    try {
      core = applyCoreAppraisal(db, selfId, { at, valence: o.valence ?? 0, arousal: o.arousal ?? 0.2, intensity: o.intensity ?? 0.5, label: o.coreLabel ?? '', cause: o.cause, msgRef: o.msgRef })
    } catch {}
  }
  return { eventId, appraisalId, episode, state, core }
}

/** 主人疲惫 → concern（target=owner，半衰期 2h）。 */
/**
 * P0-1（2026-11-12）：把一次 appraisal 推进 mood 慢层与 dominance。
 * - mood：|intensity| ≥ pushThreshold 才推动，半衰期 48h；
 * - dominance：不同规则给不同方向（被夸/工具成功↑，工具失败/自我负面↓），72h 回 0.5。
 */
export function applyAppraisalToState(db, selfId, { at = Date.now(), emotion = '', intensity = 0, valence = 0, arousal = 0.2, ruleId = '', opts = DEFAULTS } = {}) {
  const row = ensureState(db, selfId)
  const hours = Math.max(0, (Number(at) - Number(row?.updated_at ?? at)) / 3600000)
  const moodV = Number(row?.mood_valence ?? 0) * Math.pow(0.5, hours / Number(opts.moodHalfLifeHours ?? 48))
  const moodA = 0.2 + (Number(row?.mood_arousal ?? 0.2) - 0.2) * Math.pow(0.5, hours / Number(opts.moodHalfLifeHours ?? 48))
  const dom0 = Number(opts.dominanceBaseline ?? 0.5) + (Number(row?.dominance ?? 0.5) - Number(opts.dominanceBaseline ?? 0.5)) * Math.pow(0.5, hours / Number(opts.dominanceHalfLifeHours ?? 72))
  const i = Math.abs(Number(intensity) || 0)
  let nextMoodV = moodV
  let nextMoodA = moodA
  if (opts.moodEnabled !== false && i >= Number(opts.moodPushThreshold ?? 0.5)) {
    nextMoodV = clamp(moodV * 0.7 + Number(valence ?? 0) * i * 0.3, -1, 1)
    nextMoodA = clamp(moodA * 0.8 + Number(arousal ?? 0.2) * i * 0.2, 0, 1)
  }
  const delta = {
    tool_fail: -0.06,
    owner_cold: -0.03,
    owner_praise: 0.05,
    self_report_positive: 0.05,
    self_report_negative: -0.04,
    owner_distress: -0.02,
    owner_fatigue: -0.02,
  }[String(ruleId)] ?? 0
  // 兜底按情绪类型给方向（没有 ruleId 的调用）
  const byEmotion = { joy: 0.04, pride: 0.05, affection: 0.04, relief: 0.03, frustration: -0.05, sadness: -0.04, anger: -0.03, anxiety: -0.03, fatigue: -0.03, concern: -0.01 }
  // 要求 1：dominance 单次变化也有上限（不能被一条消息推到 0/1 的极端）
  const nextDom = capDelta(dom0, clamp(dom0 + (delta || byEmotion[String(emotion)] || 0) * i, 0, 1), opts.maxDeltaPerMessage)
  db.prepare('UPDATE emotion_state SET mood_valence=?, mood_arousal=?, mood_updated_at=?, dominance=?, label_updated_at=? WHERE self_id=?')
    .run(nextMoodV, nextMoodA, Number(at), nextDom, Number(at), String(selfId))
  return { moodValence: nextMoodV, moodArousal: nextMoodA, dominance: nextDom }
}

/**
 * 多情绪合成：最强活跃 episode 决定 label；没有 episode（或标签过期）才回落到 mood 调和后的 valence。
 * 要求 3（标签半衰期）：episode 标签按 labelHalfLifeMinutes 半衰；权重 <0.5（超过一个半衰期）
 * 就回落到 valence，避免「一个标签挂一天」。
 */
export function composeEmotionView(state, episodes = [], { now = Date.now(), labelHalfLifeMinutes = DEFAULTS.labelHalfLifeMinutes } = {}) {
  const minutes = Number(labelHalfLifeMinutes)
  const halfLifeMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULTS.labelHalfLifeMinutes) * 60000
  const domOf = () => (Number.isFinite(Number(state?.dominance)) ? Number(state.dominance) : null)
  const valenceView = () => {
    const v = clamp((Number(state?.valence) || 0) * 0.7 + (Number(state?.moodValence) || 0) * 0.3, -1, 1)
    const a = Number(state?.arousal ?? 0.2)
    return {
      label: labelOf(v, a, domOf()),
      intensity: intensityOf(v, a),
      episode: null,
      source: 'valence',
      labelWeight: 0,
      moodValence: state?.moodValence ?? 0,
      dominance: state?.dominance ?? 0.5,
    }
  }
  const ep = Array.isArray(episodes) ? episodes.find((e) => Number(e?.intensity) > 0) : null
  if (ep) {
    // 新鲜度锚点 = 最近一次「标签刷新」：episode 起始时间或库里的 label_updated_at
    // （新评分/新 episode 都会刷新它）；都没有的历史合成数据按新鲜处理。
    const anchors = [Number(ep.at ?? 0), Number(state?.labelUpdatedAt ?? state?.label_updated_at ?? 0)].filter(
      (x) => Number.isFinite(x) && x > 0,
    )
    const anchor = anchors.length ? Math.max(...anchors) : 0
    const weight = anchor > 0 ? Math.pow(0.5, Math.max(0, Number(now) - anchor) / halfLifeMs) : 1
    if (weight >= 0.5) {
      return {
        label: labelForEmotion(ep.emotion, state?.label),
        intensity: Number(ep.intensity) || 0,
        episode: ep,
        source: 'episode',
        labelWeight: weight,
        moodValence: state?.moodValence ?? 0,
        dominance: state?.dominance ?? 0.5,
      }
    }
  }
  return valenceView()
}

export function recordConcernEpisode(db, selfId, { at = Date.now(), intensity = 0.35, msgRef = '', excerpt = '' } = {}) {
  return recordRuleEpisode(db, selfId, {
    at,
    kind: 'owner_state',
    actor: 'owner',
    subject: 'owner',
    target: 'owner',
    goal: '主人休息',
    goalCongruence: -1,
    ruleId: 'owner_fatigue',
    emotion: 'concern',
    intensity,
    cause: CONCERN_CAUSE,
    episodeTarget: 'owner',
    halfLifeS: CONCERN_HALF_LIFE_S,
    msgRef,
    excerpt,
  })
}

/** 当前有效 episode（按各自半衰期衰减；强度 <0.15 失效），强度降序。 */
export function activeEpisodes(db, selfId, now = Date.now()) {
  try {
    const rows = db.prepare('SELECT * FROM emotion_episodes WHERE self_id=? AND expires_at>? ORDER BY at DESC').all(selfId, now)
    return rows
      .map((row) => ({
        ...row,
        intensity: Number(row.intensity) * Math.pow(0.5, (now - Number(row.at)) / (Number(row.half_life_s) * 1000)),
      }))
      .filter((row) => row.intensity >= 0.15)
      .sort((a, b) => b.intensity - a.intensity)
  } catch {
    return []
  }
}

/** 当前有效的 concern（target=owner）。 */
export function activeConcern(db, selfId, now = Date.now()) {
  return activeEpisodes(db, selfId, now).find((e) => e.emotion === 'concern' && e.target === 'owner') ?? null
}

const SELF_REPORT_RE = /我([^。！？\n]{0,6}?)(累|困|开心|高兴|难过|委屈|生气|担心|安心|慌)/
const SELF_REPORT_MAP = {
  累: ['fatigue', 0.35, 7200],
  困: ['fatigue', 0.3, 7200],
  开心: ['joy', 0.4, 3600],
  高兴: ['joy', 0.4, 3600],
  难过: ['sadness', 0.4, 7200],
  委屈: ['sadness', 0.4, 7200],
  生气: ['anger', 0.4, 3600],
  担心: ['worry', 0.35, 3600],
  安心: ['relief', 0.3, 1800],
  慌: ['anxiety', 0.4, 3600],
}

/** 她自己的第一人称明确自述；问句/转述/引用/否定都不算。 */
export function detectSelfReport(text) {
  const s = String(text ?? '').trim()
  if (!s || isQuestion(s)) return null
  if (/(?:他|她|它|别人|有人|听说|转述|引用)[^。！？\n]{0,10}我/.test(s)) return null
  if (/["“][^"”]*我[^"”]*["”]/.test(s)) return null
  const m = SELF_REPORT_RE.exec(s)
  if (!m) return null
  const between = m[1] ?? ''
  if (/[不没别未无]/.test(between)) return null
  const word = m[2]
  const [emotion, intensity, halfLifeS] = SELF_REPORT_MAP[word]
  return { emotion, target: 'self', intensity, cause: `我说我${word}`, halfLifeS, ruleId: `self_report_${emotion}`, excerpt: s.slice(0, 60) }
}

const OWNER_ACT_RULES = [
  { words: ['喜欢你', '爱你', '心疼你', '抱抱', '辛苦', '乖'], emotion: 'affection' },
  { words: ['谢谢', '真棒', '厉害', '夸你'], emotion: 'joy' },
]

/** 主人的夸奖/关心（target=owner）。 */
export function detectOwnerAct(text) {
  const s = String(text ?? '')
  for (const rule of OWNER_ACT_RULES) {
    if (rule.words.some((w) => s.includes(w))) {
      return { emotion: rule.emotion, target: 'owner', intensity: 0.4, cause: '主人夸我/关心我', halfLifeS: 3600, ruleId: 'owner_praise', excerpt: s.slice(0, 60) }
    }
  }
  return null
}

const OWNER_DISTRESS_RE = /我[^。！？\n]{0,6}?(难过|伤心|委屈|生气|焦虑|害怕|烦)/
/** 主人自身负向状态（非疲惫）→ concern；否定不算。 */
export function detectOwnerDistress(text) {
  const s = String(text ?? '')
  const m = OWNER_DISTRESS_RE.exec(s)
  if (!m) return null
  const idx = m.index + m[0].lastIndexOf(m[1])
  if (/[不没别未无]/.test(s.slice(Math.max(0, idx - 4), idx))) return null
  return { emotion: 'concern', target: 'owner', intensity: 0.4, cause: `主人${m[1]}了`, halfLifeS: CONCERN_HALF_LIFE_S, ruleId: 'owner_distress', excerpt: s.slice(0, 60) }
}

/**
 * 普通对话里的情绪线索（2026-11-13）：现有规则只认夸奖/疲惫/难过/短回复，普通聊天几乎不产生 episode。
 * 这里只认明确的情绪词/撒娇词，宁少勿多；问句不算。
 */
export function detectOwnerAffect(text) {
  const s = String(text ?? '').trim()
  if (!s || isQuestion(s)) return null
  if (/(喜欢|爱你|想你|抱抱|亲亲|贴贴|舍不得|离不开)/.test(s)) return { emotion: 'affection', intensity: 0.38, cause: '主人表达喜欢/想念', halfLifeS: 7200, ruleId: 'owner_affection' }
  if (/(哈哈|嘿嘿|笑死|开心|高兴|好耶|真棒|厉害|可爱|好乖|好幸福)/.test(s)) return { emotion: 'joy', intensity: 0.32, cause: '主人在开心/夸人', halfLifeS: 3600, ruleId: 'owner_affect_positive' }
  if (/(大笨蛋|大傻鱼|傻子|笨蛋|坏蛋|欠揍)/.test(s) || (/(傻|笨|狗|猪|坏)/.test(s) && /[你妳]/.test(s))) return { emotion: 'affection', intensity: 0.3, cause: '主人在逗她', halfLifeS: 3600, ruleId: 'owner_tease' }
  if (/(好烦|烦死|气死|难过|伤心|失望|讨厌|不想理|压力大|睡不着)/.test(s)) return { emotion: 'concern', intensity: 0.32, cause: '主人情绪不好', halfLifeS: 3600, ruleId: 'owner_affect_negative' }
  return null
}

/** 连续短回复判定（嗯/哦/好/行/啊/噢/好吧/哦哦/嗯嗯，≤2 字）。 */
export function isShortReply(text) {
  const s = String(text ?? '').replace(/[。.!！？?~～\s]/g, '').trim()
  return s.length > 0 && s.length <= 2 && /^(嗯+|哦+|好+|行|啊|噢|好吧|哦哦|嗯嗯)$/.test(s)
}

/** 工具失败判定（error/isError/ok:false）。 */
export function isToolFailure(event) {
  const data = event?.data ?? {}
  const msg = data?.message ?? data
  if (msg?.isError === true || data?.isError === true) return true
  const content = msg?.content ?? data?.content
  const text = Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ') : String(content ?? '')
  if (/^\s*Error\b|error:/i.test(text)) return true
  try {
    const j = JSON.parse(text)
    if (j && (j.ok === false || j.error)) return true
  } catch {}
  return false
}

/** 工具失败 → frustration（target=tool，10–30min 半衰期）。 */
export function recordToolFailureEpisode(db, selfId, { at = Date.now(), msgRef = '', excerpt = '' } = {}) {
  return recordRuleEpisode(db, selfId, {
    at,
    kind: 'tool_result',
    actor: 'tool',
    subject: 'tool',
    target: 'tool',
    goal: '工具成功',
    goalCongruence: -1,
    ruleId: 'tool_fail',
    emotion: 'frustration',
    intensity: 0.3,
    cause: '工具失败',
    episodeTarget: 'tool',
    halfLifeS: 1200,
    msgRef,
    excerpt,
  })
}

/**
 * 疑问句判定（问句不是陈述情绪）：结尾 ？/?/吗/呢/吧/嘛，或开头 是不是/是否/难道。
 * 例：「你不开心吗」「开心吗」「我不开心嘛」「是不是不开心」都算问句。
 */
export function isQuestion(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  return /(?:[？?]|[吗呢吧嘛])[。.!！~～…\s]*$/.test(s) || /^(?:是不是|是否|难道)/.test(s)
}

/**
 * 一条用户消息 → 更新状态、写时间线、记转折点、写审计。
 * 调用方负责先做「只处理主人真实消息」的过滤（见 isPolluted / source.kind）。
 */
export function ingestEmotion(db, selfId, { text = '', trigger, msgRef = '', at = Date.now(), opts = DEFAULTS, forceAudit = false, self = false } = {}) {
  const body = String(text ?? '')
  if (!body.trim()) throw new PersonaError(E.INVALID_ARG, '空文本不产生情绪')
  // 打分吃「剥掉时间/说话人前缀后的正文」；原始全文仍在 memory 的原话档案里。
  ensureState(db, selfId)
  const spoken = stripPromptPrefixes(body)
  const isSelf = self === true
  // P0-A：主人（非 self）的疲惫词不再写她的 fatigue，而是生成 concern；其他情绪照常。
  const ownerFatigue = !isSelf && opts.ownerFatigueIgnore !== false ? detectOwnerFatigue(spoken) : null
  const scoredText = ownerFatigue ? stripOwnerFatigue(spoken) : spoken
  const question = isQuestion(scoredText)
  let score = scoreText(scoredText)
  // 2026-11-13：她自己说“你困了/主人累了”是在照顾对方，不能因此把自己标成疲惫。
  if (isSelf && score.hint === '疲惫' && /[你您]|主人/.test(spoken)) score = { ...score, hint: null }
  const prevRaw = loadState(db, selfId)
  const prev = decayState(prevRaw, at, opts)
  // P0-B：每次交互的精力/社交电量（不影响 valence）
  applyHomeostasis(db, selfId, at, { positive: score.valence > 0 || !!ownerFatigue })
  if (ownerFatigue) recordConcernEpisode(db, selfId, { at, intensity: ownerFatigue.intensity, msgRef })

  // 她自己的消息：只认明确情绪词，且问句不参与（避免自激/自问自答拉数值）。
  if (isSelf && (score.hits === 0 || question)) return { state: prev, points: [], applied: false }

  if (score.hits === 0 || Number(score.confidence) < Number(opts.lowConfidence)) {
    if (forceAudit || Math.random() < 1 / Math.max(1, Number(opts.auditSampleRate) * 4)) {
      db.prepare("INSERT INTO emotion_audit(at,self_id,action,before_json,note) VALUES(?,?,'rule-none',?,?)")
        .run(at, selfId, JSON.stringify({ hits: score.hits, confidence: score.confidence }), '低置信/无命中，不改状态')
    }
    return { state: prev, points: [], applied: false, concern: ownerFatigue ?? null }
  }

  // 问句按 questionWeight 衰减；她自己的消息按 selfWeight 衰减；陈述=1。
  let weight = 1
  if (isSelf) weight = Number(opts.selfWeight ?? 0.3)
  else if (question) weight = Number(opts.questionWeight ?? 0.25)
  const weighted = weight === 1
    ? score
    : { ...score, valence: score.valence * weight, arousal: score.arousal * weight }
  const next = nextState(prev, weighted, at, opts)
  return tx(db, () => {
    // triggerMaxChars=0 → 不存 trigger，只保留 msg_ref（隐私口径；B2）
    const triggerLimit = Number(opts.triggerMaxChars ?? 60)
    const triggerText = triggerLimit > 0 ? masked(stripPromptPrefixes(trigger ?? body), triggerLimit) : ''
    db.prepare(
      `INSERT INTO emotion_state(self_id,valence,arousal,certainty,label,intensity,confidence,source,label_updated_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'rule',?,?)
       ON CONFLICT(self_id) DO UPDATE SET valence=excluded.valence, arousal=excluded.arousal,
         certainty=excluded.certainty, label=excluded.label, intensity=excluded.intensity,
         confidence=excluded.confidence, source=excluded.source,
         label_updated_at=excluded.label_updated_at, updated_at=excluded.updated_at`,
    ).run(selfId, next.valence, next.arousal, next.certainty, next.label, next.intensity, next.confidence, at, at)

    db.prepare(
      'INSERT INTO emotion_timeline(self_id,at,valence,arousal,label,intensity,trigger,msg_ref) VALUES(?,?,?,?,?,?,?,?)',
    ).run(selfId, at, next.valence, next.arousal, next.label, next.intensity, triggerText, String(msgRef ?? ''))

    // 要求 1：单次变化被 maxDeltaPerMessage 压住后，若 pointThreshold 比它还高就永远不会记
    // 转折点（溯源断档）。阈值取两者较小值，保证「变化到了上限」算一个转折点。
    const rawCap = Number(opts.maxDeltaPerMessage)
    const cap = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : DEFAULTS.maxDeltaPerMessage
    const rawPoint = Number(opts.pointThreshold)
    const pointThreshold = Math.min(Number.isFinite(rawPoint) && rawPoint >= 0 ? rawPoint : DEFAULTS.pointThreshold, cap)
    const made = []
    for (const [dim, before, after] of [
      ['valence', prev.valence, next.valence],
      ['arousal', prev.arousal, next.arousal],
    ]) {
      const delta = after - before
      if (Math.abs(delta) >= pointThreshold) {
        db.prepare(
          'INSERT INTO emotion_points(self_id,at,dimension,delta,value_after,trigger,msg_ref) VALUES(?,?,?,?,?,?,?)',
        ).run(selfId, at, dim, delta, after, triggerText, String(msgRef ?? ''))
        made.push({ at, dimension: dim, delta, valueAfter: after, trigger: triggerText, msgRef: String(msgRef ?? '') })
      }
    }

    if (forceAudit || Math.random() < 1 / Math.max(1, Number(opts.auditSampleRate))) {
      db.prepare("INSERT INTO emotion_audit(at,self_id,action,before_json,after_json,note) VALUES(?,?,'rule',?,?,?)")
        .run(at, selfId, JSON.stringify(prev), JSON.stringify(next), `hits=${score.hits} irony=${score.irony}`)
    }
    return { state: next, points: made, applied: true, concern: ownerFatigue ?? null }
  })
}

export function timeline(db, selfId, hours = 24, now = Date.now()) {
  return db.prepare('SELECT * FROM emotion_timeline WHERE self_id=? AND at>=? ORDER BY at').all(selfId, now - hours * 3600000)
}

export function points(db, selfId, hours = 24, now = Date.now()) {
  return db.prepare('SELECT * FROM emotion_points WHERE self_id=? AND at>=? ORDER BY at').all(selfId, now - hours * 3600000)
}

/**
 * 溯源：最近若干小时里变化最大的几个点。
 * 只返回引用与截断触发句；includeTrigger=false 或 triggerMaxChars=0 时省略 trigger。
 */
export function why(db, selfId, hours = 6, { includeTrigger = true, limit = 3, now = Date.now() } = {}) {
  const rows = db
    .prepare('SELECT * FROM emotion_points WHERE self_id=? AND at>=? ORDER BY ABS(delta) DESC, at DESC LIMIT ?')
    .all(selfId, now - hours * 3600000, limit)
  return rows.map((r) => {
    const point = {
      at: r.at,
      dimension: r.dimension,
      delta: r.delta,
      valueAfter: r.value_after,
      msgRef: r.msg_ref || 'none',
    }
    if (includeTrigger && r.trigger) point.trigger = r.trigger
    return point
  })
}

/** 标签白名单兜底：未知标签一律按「平静」注入/提示，不让旧库怪值带偏语气。 */
export function safeLabel(label) {
  const s = String(label ?? '')
  return LABELS.includes(s) ? s : '平静'
}

/** 语气提示 ≤40 字，无数字。 */
export function toneHintOf(state) {
  const label = safeLabel(state?.label)
  const tone = TONE[label] ?? TONE['平静']
  const text = `${label}，${tone}`
  return text.length <= 40 ? text : text.slice(0, 40)
}

/**
 * 注入行 ≤60 字、无数字；强度不够返回 ''。
 * 要求 4：末尾固定一句硬约束（EMOTION_RULE）——情绪只影响语气、不影响判断、不能拿捏对方；
 * 规则句只出现一次，超长时只压语气不截规则。
 */
export function emotionLine(state, { threshold = 0.35 } = {}) {
  if (Number(state?.intensity ?? 0) < threshold) return ''
  const label = safeLabel(state?.label)
  const tone = TONE[label] ?? TONE['平静']
  const head = `【你现在的情绪】${label}；这轮说话${tone}，带进用词里。`
  if (head.length + EMOTION_RULE.length <= EMOTION_LINE_MAX) return `${head}${EMOTION_RULE}`
  const room = EMOTION_LINE_MAX - EMOTION_RULE.length - `【你现在的情绪】${label}；这轮说话。`.length
  return `【你现在的情绪】${label}；这轮说话${tone.slice(0, Math.max(0, room))}。${EMOTION_RULE}`
}

/**
 * 情绪行为提示（2026-11-13）：光给标签，模型容易“知道但不用”。
 * 这里给一句可执行的行为指令，只在该情绪足够强时挂。
 */
export function emotionActHint(label, intensity, { threshold = 0.25 } = {}) {
  if (Number(intensity ?? 0) < threshold) return ''
  const L = String(label ?? '')
  const map = {
    感动: '这轮要让他听出你被哄软了：用词软一点，可以多说一句心里话，别只回嗯/好。',
    开心: '这轮可以轻快、接梗、多说半句，别压成平静陈述。',
    兴奋: '这轮话多一点、节奏快一点，允许主动接话。',
    生气: '这轮语气冲一点、句子短一点，别立刻和好。',
    难过: '这轮话少一点、软一点，允许示弱，别硬撑。',
    低落: '这轮安静一点、回得慢一点，别假装没事。',
    委屈: '这轮可以带一点撒娇/抱怨，别把委屈吞回去。',
    焦虑: '这轮可以多问一句、露出一点不安，别装作确定。',
    害怕: '这轮可以迟疑、留半句，别硬装大胆。',
    疲惫: '这轮懒一点、短一点，别安排太多。',
    得意: '这轮可以显摆一下、带点小骄傲。',
    害羞: '这轮话短一点、绕一点，别直白到底。',
    无聊: '这轮提不起劲，回得短、慢。',
  }
  return map[L] ?? ''
}

/** 粗粒度情绪行：只给标签，不含语气/原因/数值（群聊与低强度渠道用）。 */
export function coarseEmotionLine(state) {
  return `【你现在的情绪】${safeLabel(state?.label)}`
}

/**
 * 按会话场景出情绪行（渠道情绪修复）：
 * - coarse=true（群聊）：永远只给标签；
 * - always=true（渠道私聊）：强度低于阈值退化为粗粒度，保证「人格在、情绪也在」；
 * - 默认（home/owner）：沿用旧阈值行为（低于阈值返回空，不回归）。
 */
export function emotionLineFor(state, { threshold = 0.35, coarse = false, always = false } = {}) {
  if (coarse) return coarseEmotionLine(state)
  const full = emotionLine(state, { threshold })
  if (full) return full
  return always ? coarseEmotionLine(state) : ''
}

export const _internal = {
  masked,
  neutral,
  LABELS,
  TONE,
  LEXICON,
  IRONY,
  PHRASE_LEXICON,
  NEGATION_COMPOUNDS,
  stripPromptPrefixes,
}
