/** 配置与默认值。默认不注入（off）、白名单为空——阶段 2 安全起步。 */
import { join } from 'node:path'

// cosmokit 的 volatile 引用标记（dsh-settings 的 .volatile() 字段解析后就是这种只读引用）
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 把 schemastery `.volatile()` 解析出来的引用还原成普通 JSON 值。
 * cordis 在调用 apply 前会用插件导出的 Config schema 解析 profile 配置，
 * volatile 字段会变成 `{ get() }` 只读引用；loadConfig 是唯一配置读入口，
 * 所以先还原再清洗。对原本就是普通对象的配置零影响。
 */
export function unwrapVolatile(value, seen = new Set()) {
  // cosmokit 的引用带 VOLATILE_WRITE 记号；同时也接受裸 `{ get }`（测试/手工构造的引用），
  // 仅限单键对象，避免把普通配置里叫 get 的字段误当引用。
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof value.get === 'function' &&
    (VOLATILE_WRITE in value || Object.keys(value).length === 1)
  ) {
    return unwrapVolatile(value.get(), seen)
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    const out = value.map((item) => unwrapVolatile(item, seen))
    seen.delete(value)
    return out
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    if (seen.has(value)) return value
    seen.add(value)
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = unwrapVolatile(item, seen)
    seen.delete(value)
    return out
  }
  return value
}

export const DATA_DIR = process.env.DSH_PERSONA_DIR || '/sdcard/DSHA/人格/数据'
export const DB_PATH = join(DATA_DIR, 'persona.db')
export const PERSONA_PATH = join(DATA_DIR, 'persona.md')

const MODES = new Set(['full', 'brief', 'off'])
const GROUP_MODES = new Set(['off', 'brief'])

function pickMode(value, fallback = 'off') {
  const v = String(value ?? '').toLowerCase()
  return MODES.has(v) ? v : fallback
}

/** 0..1 的权重；非法/越界回落默认（不因拼错把问句当陈述或把自激开大）。 */
function pickWeight(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback
}

/** 正数配置；非法/≤0 回落默认（限速类开关不能被拼错关掉）。 */
function pickPositive(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 群聊注入档位：只允许 off / brief；未知/拼错回落 off。 */
function pickGroupMode(value) {
  const v = String(value ?? '').toLowerCase()
  return GROUP_MODES.has(v) ? v : 'off'
}

export function loadConfig(raw = {}) {
  // Config schema 的 volatile 字段是 { get() } 只读引用；唯一读入口先还原。
  raw = unwrapVolatile(raw)
  const inject = raw.inject ?? {}
  const emotion = raw.emotion ?? {}
  // dbPath/personaPath 必须跟着 dataDir 走：只传 dataDir 时不能回落到生产路径
  const dataDir = raw.dataDir || DATA_DIR
  return {
    dataDir,
    dbPath: raw.dbPath || join(dataDir, 'persona.db'),
    personaPath: raw.personaPath || join(dataDir, 'persona.md'),
    displayName: raw.displayName || '汐',
    // 设置页「人格补充」：追加在 persona.md 后面，空=不加
    appendText: String(raw.appendText ?? '').slice(0, 4000),
    selfId: raw.selfId ?? null,
    groupDirPrefix: raw.groupDirPrefix || '群_',
    logLevel: raw.logLevel || 'info',
    inject: {
    // 2026-11-12 P0：语感统计注入（由 memory 日结写 style.json）
    styleHint: false,
    stylePath: '/sdcard/DSHA/记忆/数据/style.json',
    // 2026-11-12：世界模拟原则（独立生活/不读心/因果优先）；默认关
    worldRules: false,
      // 阶段 2 默认 off：不注入，只保留服务与工具
      mode: pickMode(inject.mode, 'off'),
      briefBudgetChars: Number(inject.briefBudgetChars ?? 250),
      appendHint: inject.appendHint !== false,
      // 白名单默认空：第一次必须显式配置才会注入
      sessionDirs: Array.isArray(inject.sessionDirs) ? inject.sessionDirs : [],
      // 群聊：默认 off（契约 §4 先拒）；brief 时只给 brief 档 + 情绪行，同群 60s 限一次
      groupMode: pickGroupMode(inject.groupMode),
      // 渠道目录：这些 cwd 下的会话（含 QQ 私聊）情绪行「至少给粗粒度」，不会因为强度低于阈值整块消失
      channelDirs: Array.isArray(inject.channelDirs) ? inject.channelDirs : ['/sdcard/DSHA/渠道'],
      // dy-voice：独立表达约束块（默认开；false 关闭）
      voiceHint: inject.voiceHint !== false,
      // dy-relationship（2026-11-16）：关系底色块，恒定输出（不做阈值门控，见 lib/relationship.js）
      relationship: inject.relationship !== false,
      // 按场景的 brief 预算（home/channel/group）；空对象=全部用 briefBudgetChars（默认行为不变）
      budgetByScope: inject.budgetByScope && typeof inject.budgetByScope === 'object' && !Array.isArray(inject.budgetByScope)
        ? inject.budgetByScope
        : {},
    },
    // 事件评估（2026-11-13）：每轮普通消息一次小 LLM appraisal；失败回退规则
  appraisal: { enabled: true, timeoutMs: 8000 },
  // 德行慢轴（默认关；开了才注入性格底色，单次 ±0.03）
  virtue: { enabled: false },
  // 矛盾账本（没当场说开的事）；默认关，开了才会自动记
  grievance: {
    enabled: false,
    autoOnShortStreak: true,
    severity: 0.4,
  },
  emotion: {
      // 阶段 2 默认不接管消息流（迁移与注入在阶段 3/5）
      ingestEnabled: emotion.ingestEnabled === true,
      threshold: Number(emotion.threshold ?? 0.35),
      k: Number(emotion.k ?? 0.45),
      valenceHalfLifeHours: Number(emotion.valenceHalfLifeHours ?? 6),
      arousalHalfLifeHours: Number(emotion.arousalHalfLifeHours ?? 0.5),
      arousalBaseline: Number(emotion.arousalBaseline ?? 0.2),
      pointThreshold: Number(emotion.pointThreshold ?? 0.15),
      lowConfidence: Number(emotion.lowConfidence ?? 0.35),
      triggerMaxChars: Number(emotion.triggerMaxChars ?? 60),
      auditSampleRate: Number(emotion.auditSampleRate ?? 5),
      // 问句权重：疑问句通常不是陈述情绪，默认只按 0.25 计入
      questionWeight: pickWeight(emotion.questionWeight, 0.25),
      // 她自己的 assistant 消息权重（默认 0.3，只认明确情绪词、问句不算）
      selfWeight: pickWeight(emotion.selfWeight, 0.3),
      // 临时止血：主人 user 消息里的疲惫词不改变她的情绪（默认开；false 恢复旧行为）
      ownerFatigueIgnore: emotion.ownerFatigueIgnore !== false,
      // 2026-11-12 P0：单条消息对 valence/arousal/dominance 的变化上限（默认 0.12）
      maxDeltaPerMessage: pickPositive(emotion.maxDeltaPerMessage, 0.12),
      // 2026-11-12 P0：episode 标签半衰期（分钟，默认 45）；超过一个半衰期回落到 valence
      labelHalfLifeMinutes: pickPositive(emotion.labelHalfLifeMinutes, 45),
      // 连续多少次注入为空就告警（只计数，不写库）
      emptyStreakWarn: Number(emotion.emptyStreakWarn ?? 20),
    },
    bind: {
      // 身份轴（批次 D）：默认开；关掉后完全走 inject.sessionDirs 旧逻辑。
      enabled: raw.bind?.enabled !== false,
      // 空数组 = 跟随 inject.sessionDirs（同一个白名单）
      cwdPrefixes: Array.isArray(raw.bind?.cwdPrefixes) ? raw.bind.cwdPrefixes : [],
    },
  }
}
