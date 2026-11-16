/**
 * 注入：两个独立 context，互不改写。
 * - dy-persona（order 900）：静态人格块，byte 稳定
 * - dy-emotion（order 910）：动态情绪行，只随离散 label 变
 * 都不设 required：子智能体会话在注册前就被显式跳过，required 只作第二道保险。
 */
import { readFileSync, statSync } from 'node:fs'
import { axesText } from './axes.js'
import { effectivePersona, personaBlock, readPersonaFile } from './persona.js'
import { classify, resolveInjectBudget, resolveMode, resolveScope, SCOPES } from './scope.js'
import { bindSession, cwdBindable, personaBindingOf, SOURCE_DEFAULT } from './bindings.js'
import { peerIdOf, relationshipLine, relationshipOf } from './relationship.js'

export const CONTEXT_PERSONA = 'dy-persona'
export const CONTEXT_EMOTION = 'dy-emotion'
export const CONTEXT_EMOTION_ACT = 'dy-emotion-act'
export const CONTEXT_VOICE = 'dy-voice'
export const CONTEXT_STYLE = 'dy-style'
export const CONTEXT_GRIEVANCE = 'dy-grievance'
export const CONTEXT_WORLD = 'dy-world'
export const CONTEXT_AXES = 'dy-axes'
export const CONTEXT_RELATIONSHIP = 'dy-relationship'
export const ORDER_PERSONA = 900
export const ORDER_EMOTION = 910
export const ORDER_EMOTION_ACT = 911
export const ORDER_VOICE = 920
export const ORDER_STYLE = 915
export const ORDER_GRIEVANCE = 912
export const ORDER_WORLD = 930
export const ORDER_AXES = 925
export const ORDER_RELATIONSHIP = 913
/** 独立表达约束（≤80 字；默认开，inject.voiceHint=false 关闭）。 */
export const VOICE_HINT = '先有反应再讲道理；不总结、不列点、不复述对方问题；允许有自己的偏好和拒绝。'
/** 群聊注入限频：同一个群 60s 内最多挂一次（内存态，重启重置）。 */
export const GROUP_COOLDOWN_MS = 60_000
const styleCache = new Map()
export const WORLD_RULES = '【世界运行】人物有自己的生活，不围着对方转；只依据实际听到/看到的信息判断，不读心；事件要讲因果与连续性，不是每段对话都要推进剧情；修正问题只调频率和程度，不把整类行为禁掉。'
export function grievanceText(db, selfId) {
  try {
    if (!db || !selfId) return ''
    const rows = db.prepare("SELECT cause,severity,repeat_count FROM grievances WHERE self_id=? AND status='open' ORDER BY severity DESC, last_at DESC LIMIT 3").all(String(selfId))
    if (!rows.length) return ''
    const lines = rows.map((r) => `- ${String(r.cause).slice(0, 60)}${Number(r.repeat_count) > 1 ? `（第 ${r.repeat_count} 次）` : ''}`)
    return ['【还没说开的事】', ...lines, '不用每句都提；但别当没发生，合适的时候可以说开。'].join('\n')
  } catch { return '' }
}
/** 读 memory 日结写的 style.json；文件不存在/太旧/空则返回 ''（不阻塞人格）。 */
export function readStyleLine(path, { maxAgeMs = 14 * 86400000, now = Date.now() } = {}) {
  try {
    const st = statSync(path)
    if (!st.isFile() || now - Number(st.mtimeMs) > maxAgeMs) return ''
    const hit = styleCache.get(path)
    if (hit && hit.mtime === Number(st.mtimeMs)) return hit.line
    const obj = JSON.parse(readFileSync(path, 'utf8'))
    const line = String(obj?.summaryLine ?? '').trim()
    const out = line ? `【语感】${line.slice(0, 160)}` : ''
    styleCache.set(path, { mtime: Number(st.mtimeMs), line: out })
    return out
  } catch { return '' }
}

export function createInjector({ cfg, log, state, now = () => Date.now() }) {
  const mounted = new Map()
  const groupLastMounted = new Map()

  /** 每次组装/读服务时从 DB 刷新 self（改名/版本变更立刻生效）；失败静默回退内存快照。 */
  function currentSelf() {
    let self = state.self
    try {
      if (typeof state.refreshSelf === 'function') self = state.refreshSelf() ?? state.self
    } catch {}
    return self
  }

  function buildPersonaText(mode, header) {
    return personaBlock({
      raw: effectivePersona(readPersonaFile(cfg.personaPath), cfg.appendText),
      displayName: currentSelf()?.display_name ?? '',
      mode,
      // brief 预算按场景（home/channel/group）；默认 budgetByScope={} 时仍是 briefBudgetChars
      budget: resolveInjectBudget(header, cfg),
      appendHint: cfg.inject.appendHint,
    }).text
  }

  /** 命中 cwd 前缀时落一条 persona 绑定（失败静默，不阻断注入）。 */
  function writeBinding(header, sid, personaId) {
    if (!state.db || !personaId || !cwdBindable(header.cwd, cfg)) return null
    try {
      return bindSession(state.db, {
        sessionId: sid,
        personaId,
        role: 'persona',
        cwd: String(header.cwd ?? ''),
        source: SOURCE_DEFAULT,
      })
    } catch {
      return null
    }
  }

  /**
   * @returns {{mounted:boolean, reason:string, mode?:string}}
   */
  function mount(agent) {
    const header = agent?.session?.header ?? {}
    const sid = String(header.id ?? '')
    if (!sid) return { mounted: false, reason: 'no-session' }
    if (mounted.has(sid)) return { mounted: false, reason: 'already-mounted' }

    // 契约 §4：真子智能体先拒；群聊按 inject.groupMode 决定（默认 off=拒）。
    const kind = classify(header, cfg)
    if (kind === SCOPES.SUBAGENT) return { mounted: false, reason: 'subagent' }

    let mode
    let reason
    if (kind === SCOPES.GROUP) {
      if (cfg.inject.groupMode !== 'brief') return { mounted: false, reason: 'group' }
      const groupKey = String(header.cwd ?? '')
      const last = groupLastMounted.get(groupKey)
      if (last !== undefined && now() - last < GROUP_COOLDOWN_MS) return { mounted: false, reason: 'group-throttled' }
      // 群聊只给 brief + 情绪行，不给完整人格
      mode = 'brief'
      reason = 'group-brief'
    } else {
      // 身份轴：cwd 命中前缀 → 幂等写入；随后先查 binding，未命中再走旧 cwd 白名单。
      const bindingEnabled = cfg.bind?.enabled !== false
      const personaId = state.self?.id
      if (bindingEnabled) writeBinding(header, sid, personaId)
      const binding = bindingEnabled ? personaBindingOf(state.db, sid, personaId) : null

      if (binding) {
        const rawMode = resolveMode(header, cfg)
        if (rawMode === 'off') return { mounted: false, reason: 'mode-off' }
        mode = rawMode === 'brief' ? 'brief' : 'full'
        reason = 'binding'
      } else {
        const scope = resolveScope(header, cfg)
        if (!scope.allow) return { mounted: false, reason: scope.reason }
        mode = scope.mode === 'brief' ? 'brief' : 'full'
        reason = scope.reason
      }
    }

    const personaText = buildPersonaText(mode, header)
    if (!personaText) return { mounted: false, reason: 'empty-persona' }

    const offs = []
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: CONTEXT_PERSONA,
          order: ORDER_PERSONA,
          // 人格正文来自用户可编辑的 persona.md：不得参与宿主 `{{var}}` 解析，
          // 否则文件里出现未注册占位符会让整轮 prompt 抛 unknown prompt variable。
          interpolate: false,
          text: () => buildPersonaText(mode, header),
        }),
      )
    } catch (error) {
      if (!String(error?.message ?? error).includes('already registered')) {
        log.warn?.(`[persona] 挂 dy-persona 失败：${error?.message ?? error}`)
        return { mounted: false, reason: 'register-failed' }
      }
    }
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: CONTEXT_EMOTION,
          order: ORDER_EMOTION,
          // 动态文本一律字面量（情绪行不含宿主变量，加保护防止以后带来源句时炸）。
          interpolate: false,
          // 按会话场景出情绪行：群聊粗粒度；渠道私聊低于阈值也至少给标签。
          text: () => (state.emotionLineFor ? state.emotionLineFor(header) : state.emotionLine?.() ?? ''),
        }),
      )
    } catch (error) {
      if (!String(error?.message ?? error).includes('already registered')) {
        log.warn?.(`[persona] 挂 dy-emotion 失败：${error?.message ?? error}`)
      }
    }
    // dy-voice：很短的独立表达约束（默认开；与人格/情绪分开，改动不影响人格块稳定性）
    if (cfg.inject.voiceHint !== false) {
      try {
        offs.push(
          agent.ctx.systemPrompt.context({
            name: CONTEXT_VOICE,
            order: ORDER_VOICE,
            interpolate: false,
            text: () => VOICE_HINT,
          }),
        )
      } catch (error) {
        if (!String(error?.message ?? error).includes('already registered')) {
          log.warn?.(`[persona] 挂 dy-voice 失败：${error?.message ?? error}`)
        }
      }
    }
    // dy-emotion-act：强情绪时给一句可执行的行为指令（群聊不挂；当前情绪弱就不挂，避免空 context）
    if (kind !== SCOPES.GROUP) {
      try {
        offs.push(agent.ctx.systemPrompt.context({
          name: CONTEXT_EMOTION_ACT,
          order: ORDER_EMOTION_ACT,
          interpolate: false,
          // 文本动态：情绪弱时为空串；强时给一句行为指令（不能只在挂载时判空，否则后来变强也不会出现）
          text: () => (state.service?._emotionActFor ? state.service._emotionActFor(header) : ''),
        }))
      } catch (error) {
        if (!String(error?.message ?? error).includes('already registered')) log.warn?.(`[persona] 挂 dy-emotion-act 失败：${error?.message ?? error}`)
      }
    }
    // dy-style：从主人最近 300 条消息算出的语感（memory 日结写文件；群聊不挂，避免串主人语感）
    if (kind !== SCOPES.GROUP && cfg.inject?.styleHint !== false) {
      const styleText = readStyleLine(cfg.inject?.stylePath ?? '/sdcard/DSHA/记忆/数据/style.json', { now: now() })
      if (styleText) {
        try {
          offs.push(
            agent.ctx.systemPrompt.context({
              name: CONTEXT_STYLE,
              order: ORDER_STYLE,
              interpolate: false,
              text: () => styleText,
            }),
          )
        } catch (error) {
          if (!String(error?.message ?? error).includes('already registered')) {
            log.warn?.(`[persona] 挂 dy-style 失败：${error?.message ?? error}`)
          }
        }
      }
    }
    // dy-grievance：关系里还没说开的事（默认关；开了才查表）
    if (kind !== SCOPES.GROUP && cfg.grievance?.enabled === true) {
      const gtext = grievanceText(state.db, state.self?.id)
      if (gtext) {
        try {
          offs.push(agent.ctx.systemPrompt.context({ name: CONTEXT_GRIEVANCE, order: ORDER_GRIEVANCE, interpolate: false, text: () => gtext }))
        } catch (error) {
          if (!String(error?.message ?? error).includes('already registered')) log.warn?.(`[persona] 挂 dy-grievance 失败：${error?.message ?? error}`)
        }
      }
    }
    // dy-relationship（2026-11-16）：关系底色（trust/warmth/familiarity/tension 的分档文案 + 固定防御句）。
    // **恒定输出、不做阈值门控**：这正是治 lib/emo-observe.js:3-6 自述的「情绪行常年空串」——
    // 关系块永远有内容，模型至少知道"现在跟这个人处在什么档位"。
    // 纯读：relationshipOf 只算不写；DB 不可用/无行时回落到初值文案，绝不抛。
    if (kind !== SCOPES.GROUP && cfg.inject?.relationship !== false) {
      const peerId = peerIdOf(header)
      try {
        offs.push(
          agent.ctx.systemPrompt.context({
            name: CONTEXT_RELATIONSHIP,
            order: ORDER_RELATIONSHIP,
            interpolate: false,
            text: () => {
              let rel = null
              try {
                const db = state.db
                const selfId = currentSelf()?.id
                if (db && selfId) rel = relationshipOf(db, selfId, peerId, now())
              } catch {}
              let mood = null
              try { mood = state.service?.emotion?.state?.() ?? null } catch {}
              return relationshipLine(rel, { valence: mood?.valence ?? 0, arousal: mood?.arousal ?? 0.2 })
            },
          }),
        )
      } catch (error) {
        if (!String(error?.message ?? error).includes('already registered')) log.warn?.(`[persona] 挂 dy-relationship 失败：${error?.message ?? error}`)
      }
    }
    // dy-axes：性格底色（默认关；开了才注入）
    if (kind !== SCOPES.GROUP && cfg.virtue?.enabled === true) {
      const atext = axesText(state.db, state.self?.id)
      if (atext) {
        try { offs.push(agent.ctx.systemPrompt.context({ name: CONTEXT_AXES, order: ORDER_AXES, interpolate: false, text: () => atext })) }
        catch (error) { if (!String(error?.message ?? error).includes('already registered')) log.warn?.(`[persona] 挂 dy-axes 失败：${error?.message ?? error}`) }
      }
    }
    // dy-world：世界模拟原则（默认关）
    if (kind !== SCOPES.GROUP && cfg.inject?.worldRules === true) {
      try {
        offs.push(agent.ctx.systemPrompt.context({ name: CONTEXT_WORLD, order: ORDER_WORLD, interpolate: false, text: () => WORLD_RULES }))
      } catch (error) {
        if (!String(error?.message ?? error).includes('already registered')) log.warn?.(`[persona] 挂 dy-world 失败：${error?.message ?? error}`)
      }
    }
    if (kind === SCOPES.GROUP) groupLastMounted.set(String(header.cwd ?? ''), now())
    mounted.set(sid, offs)
    log.info?.(`[persona] 注入已挂载 mode=${mode} sid=${sid.slice(0, 8)} reason=${reason}`)
    return { mounted: true, reason, mode }
  }

  function unmount(sessionId) {
    const offs = mounted.get(String(sessionId ?? ''))
    if (!offs) return false
    for (const off of offs) {
      try {
        off?.()
      } catch {}
    }
    mounted.delete(String(sessionId))
    return true
  }

  return {
    mount,
    unmount,
    mountedCount: () => mounted.size,
    isMounted: (sid) => mounted.has(String(sid ?? '')),
  }
}
