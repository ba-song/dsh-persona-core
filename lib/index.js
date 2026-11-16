/**
 * dsh-persona-core：汐的独立人格 + 情绪（阶段 2 骨架）。
 *
 * 阶段 2 口径：
 * - 注入默认 off、白名单为空：不注入，只提供 dyPersona 服务与工具
 * - 不接管消息流（emotion.ingestEnabled 默认 false）
 * - 不碰 onebot / profile / 记忆插件
 */
import { E, getMeta, openDb, PersonaError, setMeta } from './db.js'
import { ensureSelf, syncPersonaVersion } from './self.js'
import { loadConfig } from './config.js'
import { effectivePersona, personaSelfCheck, readPersonaFile } from './persona.js'
import { createPersonaService } from './service.js'
import { createInjector } from './inject.js'
import { ensureBindingsTable } from './bindings.js'
import { registerTools } from './tools.js'
import {
  applyHomeostasis,
  detectOwnerAct,
  detectOwnerAffect,
  detectOwnerDistress,
  detectOwnerFatigue,
  detectSelfReport,
  ingestEmotion,
  ensureState,
  isPolluted,
  isShortReply,
  isToolFailure,
  labelForEmotion,
  recordRuleEpisode,
  recordToolFailureEpisode,
  stripPromptPrefixes,
} from './emotion.js'
import { classify, resolveScope } from './scope.js'
import { appraiseByLlm } from './appraisal.js'
import { createEmotionObserver } from './emo-observe.js'
import { peerIdOf, writeAttunement } from './relationship.js'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-persona-core'
export const inject = ['tools', 'systemPrompt', 'agents']

/**
 * 设置页只认识 Config schema 里标了 `.volatile()` 的字段（dsh-settings 的
 * `volatileForm`/`isVolatilePath`），所以这里只声明设置卡片暴露的 3 个字段：
 *   - inject.mode
 *   - emotion.ingestEnabled
 *   - emotion.threshold
 * 未声明的键（dataDir、inject.appendHint/sessionDirs、emotion.k/... 等）走
 * schemastery 的非 strict 合并原样保留，loadConfig 继续按原默认值清洗，
 * 运行时行为不变（apply 仍然只是 loadConfig(raw)，入口先还原 volatile 引用）。
 * 这里的默认值只用于设置页展示；loadConfig 的运行时兜底仍是安全起步 off。
 */
export const Config = z.object({
  inject: z
    .object({
      mode: z
        .union([z.const('full'), z.const('brief'), z.const('off')])
        .default('full')
        .volatile(),
      worldRules: z.boolean().default(false).volatile(),
      styleHint: z.boolean().default(false).volatile(),
    })
    .default({}),
  emotion: z
    .object({
      ingestEnabled: z.boolean().default(false).volatile(),
      threshold: z.number().min(0).max(1).default(0.35).volatile(),
    })
    .default({}),
  appraisal: z.object({ enabled: z.boolean().default(true).volatile() }).default({}),
  grievance: z.object({ enabled: z.boolean().default(false).volatile() }).default({}),
  virtue: z.object({ enabled: z.boolean().default(false).volatile() }).default({}),
  // 设置页「人格补充」：追加在 persona.md 后面，空=不加
  appendText: z.string().default('').volatile(),
})

export function apply(ctx, raw = {}) {
  const cfg = loadConfig(raw)
  const log = ctx?.logger && typeof ctx.logger.info === 'function' ? ctx.logger : console

  const state = { db: null, self: null, service: null, emotionLine: () => '', emoStats: null }

  // 打开 DB：失败不阻塞宿主，服务降级
  try {
    state.db = openDb(cfg.dbPath)
  } catch (error) {
    log.error?.(`[persona] persona.db 打不开：${error?.message ?? error}`)
  }

  if (state.db) {
    // 身份轴表：幂等补建（表已存在时 no-op；失败只影响绑定，不阻断启动）
    try {
      ensureBindingsTable(state.db)
    } catch {}
    try {
      // 配置只在首次建行时作 seed；之后以库为准
      state.self = ensureSelf(state.db, cfg.displayName, cfg.selfId)
      // B5：把 self_id 固化进 meta（首次写入；之后发现不一致只告警不覆盖，防止库被换掉后静默换人）
      try {
        if (state.self?.id) {
          const stored = getMeta(state.db, 'self_id')
          if (!stored) setMeta(state.db, 'self_id', state.self.id)
          else if (String(stored) !== String(state.self.id)) {
            log.error?.(`[persona] self_id 与库不一致：meta=${stored} db=${state.self.id}（疑似库被替换，不自动覆盖）`)
          }
        }
      } catch {}
    } catch (error) {
      // E_SELF_CONFLICT：不注入、不改库，工具报冲突
      log.error?.(`[persona] ${error.code ?? 'E_PERSONA_UNAVAILABLE'}：${error.message}`)
      state.self = null
    }
  }

  if (state.self) {
    try {
      const raw = effectivePersona(readPersonaFile(cfg.personaPath), cfg.appendText)
      // 文件缺失/为空时不写快照、不升版本（避免把「空人格」记成新版本）
      const v = raw.trim() ? syncPersonaVersion(state.db, state.self.id, raw) : { version: Number(state.self.persona_version), hash: '', changed: false }
      state.self = state.db.prepare('SELECT * FROM self WHERE id=?').get(state.self.id)
      log.info?.(`[persona] 人格版本 v${v.version} hash=${v.hash.slice(0, 8)}${v.changed ? '（已写快照）' : ''}`)
    } catch (error) {
      log.warn?.(`[persona] 人格版本同步失败：${error?.message ?? error}`)
    }
    try {
      ensureState(state.db, state.self.id)
    } catch {}
  }

  // B3：从 DB 刷新 self（名字/人格版本）；失败静默回退内存快照，不阻断注入/服务。
  const refreshSelf = () => {
    const cur = state.self
    if (!state.db || !cur?.id) return state.self
    try {
      const row = state.db.prepare('SELECT * FROM self WHERE id=?').get(cur.id)
      if (row) state.self = row
      return state.self
    } catch {
      return state.self
    }
  }
  state.refreshSelf = refreshSelf

  state.service = createPersonaService({ db: () => state.db, cfg, self: refreshSelf })
  // 情绪注入观测：连续为空计数（阈值 0.35 下迁移数据一直是空，用告警提示，不写库）
  const observer = createEmotionObserver({
    threshold: cfg.emotion.threshold,
    warnEvery: cfg.emotion.emptyStreakWarn,
    log,
  })
  state.emoStats = () => observer.stats()
  state.emotionLine = () => observer.sample(state.service._emotionLine())
  // 按会话场景出情绪行：群聊粗粒度；渠道私聊低于阈值也至少给标签（home 沿用旧行为）
  state.emotionLineFor = (header) => observer.sample(state.service._emotionLineFor(header))

  // 服务：契约 v1.1 的服务名 dyPersona
  try {
    if (typeof ctx?.provide === 'function') ctx.provide('dyPersona', state.service)
    else log.warn?.('[persona] ctx.provide 不可用，dyPersona 服务未注册')
  } catch (error) {
    log.error?.(`[persona] provide('dyPersona') 失败：${error?.message ?? error}`)
  }

  // 工具
  try {
    const tools = ctx.get?.('tools')
    if (tools?.register) registerTools({ tools, cfg, state, log })
    else log.warn?.('[persona] tools 服务不可用，工具未注册')
  } catch (error) {
    log.warn?.(`[persona] 注册工具失败：${error?.message ?? error}`)
  }

  // 启动自检：只报问题类型，不打印正文
  try {
    const check = personaSelfCheck(effectivePersona(readPersonaFile(cfg.personaPath), cfg.appendText))
    if (!check.ok) log.warn?.(`[persona] persona.md 自检提示：${check.issues.join('；')}`)
  } catch {}

  // 注入
  const injector = createInjector({ cfg, log, state })
  const mountExisting = () => {
    try {
      state.refreshSelf?.()
      for (const agent of ctx.agents?.list?.() ?? []) injector.mount(agent)
    } catch {}
  }
  mountExisting()
  ctx.on?.('agent/created', (payload) => {
    try {
      state.refreshSelf?.()
      injector.mount(payload?.agent ?? payload)
    } catch (error) {
      log.warn?.(`[persona] 挂载失败：${error?.message ?? error}`)
    }
  })
  ctx.on?.('agent/disposed', (payload) => {
    try {
      const header = (payload?.agent ?? payload)?.session?.header ?? {}
      injector.unmount(header.id)
    } catch {}
  })

  // 情绪接管（阶段 2 默认关闭；阶段 3 迁移后再开）
  if (cfg.emotion.ingestEnabled) {
    const shortStreak = new Map()
    const recentBySession = new Map()
    ctx.on?.('session/event', (session, event) => {
      try {
        const header = session?.header ?? {}
        if (classify(header, cfg) !== 'private') return
        const scope = resolveScope(header, cfg)
        if (!scope.allow) return
        const type = String(event?.type ?? '')
        const at = Number(event?.time ?? Date.now())
        const selfId = state.self.id
        const msgRefBase = `${header.id ?? ''}:${event?.seq ?? 0}`

        // P1a：工具结果失败 → frustration（成功不产生情绪）
        if (type === 'tool/result') {
          if (!isToolFailure(event)) return
          const ref = `tool:${msgRefBase}`
          const last = state.db.prepare("SELECT value FROM meta WHERE key='last_emotion_tool_ref'").get()?.value
          if (last === ref) return
          state.db
            .prepare("INSERT INTO meta(key,value) VALUES('last_emotion_tool_ref',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .run(ref)
          recordToolFailureEpisode(state.db, selfId, { at, msgRef: ref })
          return
        }

        const self = type === 'assistant/message'
        if (!self && type !== 'user/message') return
        if (self && !(Number(cfg.emotion.selfWeight) > 0)) return
        const data = event?.data ?? {}
        if (!self) {
          const kind = String(data?.source?.kind ?? data?.message?.source?.kind ?? '')
          if (kind !== 'user') return
        }
        const content = self ? data?.message?.content : data?.content ?? data?.message?.content
        const text = Array.isArray(content)
          ? content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ')
          : String(content ?? '')
        // 先剥系统/渠道前缀，再判断「剥完还剩不剩她的话」；系统块本身不该改变心情。
        const clean = stripPromptPrefixes(text)
        if (!clean.trim() || isPolluted(clean)) return
        const msgRef = self ? `self:${msgRefBase}` : `explicit:${msgRefBase}`
        const refKey = self ? 'last_emotion_self_ref' : 'last_emotion_msg_ref'
        const lastRef = state.db.prepare('SELECT value FROM meta WHERE key=?').get(refKey)?.value
        if (lastRef === msgRef) return
        state.db
          .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(refKey, msgRef)

        // 最近几轮上下文（给 appraisal 用；不持久化）
        const recentKey = String(header.id ?? '')
        const prevRecent = recentBySession.get(recentKey) ?? []
        const nextRecent = [...prevRecent, `${self ? '汐' : '主人'}：${clean}`].slice(-6)
        recentBySession.set(recentKey, nextRecent)

        // 她自己的自述：只认第一人称明确情绪；问句/转述/引用不算
        if (self) {
          const report = detectSelfReport(clean)
          if (report) {
            recordRuleEpisode(state.db, selfId, {
              at,
              peerId,
              kind: 'self_report',
              actor: 'self',
              subject: 'self',
              target: 'self',
              ruleId: report.ruleId,
              emotion: report.emotion,
              intensity: report.intensity,
              cause: report.cause,
              episodeTarget: 'self',
              halfLifeS: report.halfLifeS,
              msgRef,
              excerpt: clean,
            })
          }
          ingestEmotion(state.db, selfId, { text: clean, msgRef, at, opts: cfg.emotion, self: true })
          return
        }

        // 主人：① 自身疲惫 → concern（P0，ingest 内写事件/评估/episode）② 自身难过 → concern
        if (detectOwnerFatigue(clean) || detectOwnerDistress(clean)) {
          const distress = detectOwnerDistress(clean)
          if (!detectOwnerFatigue(clean) && distress) {
            recordRuleEpisode(state.db, selfId, {
              at,
              peerId,
              kind: 'owner_state',
              actor: 'owner',
              subject: 'owner',
              target: 'owner',
              ruleId: distress.ruleId,
              emotion: 'concern',
              intensity: distress.intensity,
              cause: distress.cause,
              episodeTarget: 'owner',
              halfLifeS: distress.halfLifeS,
              msgRef,
              excerpt: clean,
            })
            applyHomeostasis(state.db, selfId, at, { positive: false })
            return
          }
          ingestEmotion(state.db, selfId, { text: clean, msgRef, at, opts: cfg.emotion, self: false })
          return
        }

        // ③ 主人夸奖/关心 → joy/affection（target=owner）；旧词典路径仅供 owner_act
        const act = detectOwnerAct(clean)
        if (act) {
          recordRuleEpisode(state.db, selfId, {
            at,
            peerId,
            kind: 'owner_act',
            actor: 'owner',
            subject: 'owner',
            target: 'self',
            ruleId: act.ruleId,
            emotion: act.emotion,
            intensity: act.intensity,
            cause: act.cause,
            episodeTarget: 'owner',
            halfLifeS: act.halfLifeS,
            msgRef,
            excerpt: clean,
          })
          ingestEmotion(state.db, selfId, { text: clean, msgRef, at, opts: cfg.emotion, self: false })
          return
        }

        // ③b 普通对话里的明确情绪线索（2026-11-13；只认词，不猜）
        const affect = detectOwnerAffect(clean)
        if (affect) {
          recordRuleEpisode(state.db, selfId, {
            at,
            peerId,
            kind: 'owner_act',
            actor: 'owner',
            subject: 'owner',
            target: 'self',
            ruleId: affect.ruleId,
            emotion: affect.emotion,
            intensity: affect.intensity,
            cause: affect.cause,
            episodeTarget: 'owner',
            halfLifeS: affect.halfLifeS,
            msgRef,
            excerpt: clean,
          })
          ingestEmotion(state.db, selfId, { text: clean, msgRef, at, opts: cfg.emotion, self: false })
          return
        }

        // ④ 连续短回复 → worry/loneliness（同一段只发一次）
        const sid = String(header.id ?? '')
        if (isShortReply(clean)) {
          const n = Number(shortStreak.get(sid) ?? 0) + 1
          shortStreak.set(sid, n)
          if (n === 3) {
            recordRuleEpisode(state.db, selfId, {
              at,
              peerId,
              kind: 'owner_act',
              actor: 'owner',
              subject: 'owner',
              target: 'self',
              ruleId: 'owner_cold',
              emotion: 'worry',
              intensity: 0.25,
              cause: '主人回复很短',
              episodeTarget: 'owner',
              halfLifeS: 3600,
              msgRef,
              excerpt: clean,
            })
            if (cfg.grievance?.enabled === true && cfg.grievance?.autoOnShortStreak !== false) {
              try { openGrievance(state.db, selfId, { cause: '主人连续几次只回很短的话', severity: Number(cfg.grievance.severity ?? 0.4), at, note: clean.slice(0, 100) }) } catch {}
            }
          }
        } else {
          shortStreak.set(sid, 0)
        }
        // ⑤ 普通陈述：精力/社交照旧；情绪改由 LLM appraisal 给（失败就什么都不加）
        applyHomeostasis(state.db, selfId, at, { positive: false })
        if (cfg.appraisal?.enabled !== false) {
          const ctxRef = ctx
          void (async () => {
            const p = await appraiseByLlm({ ctx: ctxRef, text: clean, recent: nextRecent.slice(0, -1), timeoutMs: cfg.appraisal?.timeoutMs, log })
            if (!p) return
            try {
              const recorded = recordRuleEpisode(state.db, selfId, {
                at,
                peerId,
                kind: 'appraisal',
                actor: 'owner',
                subject: 'owner',
                target: 'self',
                ruleId: 'llm_appraisal',
                emotion: p.emotion,
                intensity: p.intensity,
                valence: p.valence,
                arousal: p.arousal,
                cause: p.cause || p.facts || '事件评估',
                episodeTarget: p.target,
                halfLifeS: 3600,
                msgRef,
                excerpt: clean,
                coreLabel: labelForEmotion(p.emotion),
              })
              // 2026-11-16：attunement（intent/user_cue/uncertainty/avoid）写回该条 appraisal；
              // 模型没给就不写，绝不编造。
              if (p.attunement) writeAttunement(state.db, recorded?.appraisalId, p.attunement)
              state.db.prepare('UPDATE emotion_state SET strategy_json=?, strategy_at=? WHERE self_id=?')
                .run(JSON.stringify(p.strategy ?? {}), at, selfId)
            } catch (e) { log.warn?.(`[persona] appraisal 落库失败：${e?.message ?? e}`) }
          })()
        }
      } catch (error) {
        if (error instanceof PersonaError && error.code === E.PERMISSION) return
        log.warn?.(`[persona] 情绪更新失败：${error?.message ?? error}`)
      }
    })
  }

  log.info?.(
    `[persona] 就绪 self=${state.self ? `${state.self.id.slice(0, 13)}…` : '(none)'} ` +
      `name=${state.self?.display_name ?? '-'} mode=${cfg.inject.mode} allowlist=${cfg.inject.sessionDirs.length} ` +
      `emotionIngest=${cfg.emotion.ingestEnabled}`,
  )
}
