/**
 * dyPersona 服务（契约 v1.1 §2）。
 * 所有方法不抛（除 emotion.why 的权限错误与 E_INVALID_ARG）；DB 不可用时降级。
 */
import { PersonaError, E } from './db.js'
import { personaBlock, personaHash, readPersonaFile, renderPersona, voiceOf } from './persona.js'
import { activeEpisodes, composeEmotionView, currentState, EMOTION_RULE, emotionActHint, emotionLine, emotionLineFor, ensureState, toneHintOf, why as whyRows } from './emotion.js'
import { strategyText } from './appraisal.js'
import { classify, isChannelCwd, assertOwnerCall, headerOf } from './scope.js'
import { getBinding } from './bindings.js'

/** 情绪时间线行 → 对外只读结构（不含 trigger/msg_ref，避免泄露对话正文）。 */
function timelineRow(row) {
  if (!row) return null
  return {
    at: Number(row.at),
    label: String(row.label ?? ''),
    intensity: Number(row.intensity ?? 0),
    valence: Number(row.valence ?? 0),
    arousal: Number(row.arousal ?? 0),
    confidence: row.confidence === undefined || row.confidence === null ? null : Number(row.confidence),
  }
}

function headerFromOpts(opts) {
  if (!opts || typeof opts !== 'object') return undefined
  if (opts.header !== undefined) return opts.header
  if (opts.session?.header !== undefined) return opts.session.header
  return undefined
}

/**
 * @param {object} deps
 * @param {() => object|null} deps.db        取连接（null 表示不可用）
 * @param {object} deps.cfg
 * @param {() => object|null} deps.self      当前 self 行
 * @param {() => string} deps.mode           当前生效档位
 */
export function createPersonaService({ db, cfg, self }) {
  const conn = () => {
    try {
      return db()
    } catch {
      return null
    }
  }
  const row = () => {
    try {
      return self()
    } catch {
      return null
    }
  }

  const rawText = () => {
    try {
      return readPersonaFile(cfg.personaPath)
    } catch {
      return ''
    }
  }

  return {
    selfId() {
      try {
        return row()?.id ?? 'self:unknown'
      } catch {
        return 'self:unknown'
      }
    },
    displayName() {
      try {
        return row()?.display_name ?? ''
      } catch {
        return ''
      }
    },
    personaText() {
      try {
        const r = row()
        const raw = rawText()
        if (!raw.trim()) return ''
        return renderPersona(raw, r?.display_name ?? '').trim()
      } catch {
        return ''
      }
    },
    voice() {
      try {
        return voiceOf(rawText(), row()?.display_name ?? '', 120)
      } catch {
        return ''
      }
    },
    block() {
      try {
        const mode = cfg?.inject?.mode ?? 'off'
        return personaBlock({
          raw: rawText(),
          displayName: row()?.display_name ?? '',
          mode,
          budget: Number(cfg?.inject?.briefBudgetChars ?? 250),
          appendHint: cfg?.inject?.appendHint !== false,
        })
      } catch {
        return { mode: 'off', text: '' }
      }
    },
    version() {
      try {
        const raw = rawText()
        return {
          personaVersion: Number(row()?.persona_version ?? 1),
          nameVersion: Number(row()?.name_version ?? 0),
          // 无人格文件时 hash 给空串（不要给 sha256("") 的假值）
          hash: raw.trim() ? personaHash(raw) : '',
        }
      } catch {
        return { personaVersion: 1, nameVersion: 0, hash: '' }
      }
    },
    /**
     * 只读身份轴（给 memory/autonomy 用）：按 sessionId 查绑定行。
     * 无权限限制（只读元数据）；缺表/缺行 → null，不抛。
     */
    bindingOf(sessionId) {
      try {
        const c = conn()
        const sid = String(sessionId ?? '')
        if (!c || !sid) return null
        const b = getBinding(c, sid)
        return b ? { ...b, bound: true } : null
      } catch {
        return null
      }
    },
    /**
     * 只读身份轴：按会话 header 返回 { session_id, persona_id, role, bound }。
     * 永远返回对象；缺表/缺行 → bound:false（方便 memory 判「这是不是她的会话」）。
     */
    roleOf(header) {
      try {
        const h = headerOf(header)
        const sid = String(h?.id ?? '')
        if (!sid) return { session_id: null, persona_id: null, role: null, bound: false }
        const c = conn()
        const b = c ? getBinding(c, sid) : null
        if (!b) return { session_id: sid, persona_id: null, role: null, bound: false }
        return { session_id: sid, persona_id: b.persona_id, role: b.role, bound: true }
      } catch {
        return { session_id: null, persona_id: null, role: null, bound: false }
      }
    },
    /**
     * 只读：某时间点 ±windowMs 内最近的一条情绪（给记忆回填用）。
     * 返回 {at,label,intensity,valence,arousal,confidence}；无数据/缺表 → null。
     * 说明：emotion_timeline 目前没有 confidence 列，返回 null（不编造）；以后加列会自动返回数值。
     */
    emotionAt(at, { windowMs = 600000 } = {}) {
      try {
        const t = Number(at)
        if (!Number.isFinite(t)) return null
        const w = Math.max(0, Number(windowMs) || 0)
        const c = conn()
        const r = row()
        if (!c || !r) return null
        const sql = (withConfidence) =>
          `SELECT ${withConfidence ? 'at,label,intensity,valence,arousal,confidence' : 'at,label,intensity,valence,arousal'} ` +
          'FROM emotion_timeline WHERE self_id=? AND at BETWEEN ? AND ? ORDER BY ABS(at-?) ASC, at DESC LIMIT 1'
        let hit
        try {
          hit = c.prepare(sql(true)).get(r.id, t - w, t + w, t)
        } catch {
          hit = c.prepare(sql(false)).get(r.id, t - w, t + w, t)
        }
        return timelineRow(hit)
      } catch {
        return null
      }
    },
    /**
     * 只读：按时间倒序返回情绪时间线（给记忆取 ±2 条范围用）。
     * 返回 [{at,label,intensity,valence,arousal,confidence}]；无数据/缺表 → []。
     */
    emotionTimeline({ from, to, limit = 20 } = {}) {
      try {
        const c = conn()
        const r = row()
        if (!c || !r) return []
        const fromN = Number.isFinite(Number(from)) ? Number(from) : 0
        const toN = Number.isFinite(Number(to)) ? Number(to) : Date.now()
        if (fromN > toN) return []
        const n = Math.trunc(Number(limit))
        if (!Number.isFinite(n) || n <= 0) return []
        const cap = Math.min(n, 200)
        const base = 'FROM emotion_timeline WHERE self_id=? AND at>=? AND at<=? ORDER BY at DESC, id DESC LIMIT ?'
        let rows
        try {
          rows = c.prepare(`SELECT at,label,intensity,valence,arousal,confidence ${base}`).all(r.id, fromN, toN, cap)
        } catch {
          rows = c.prepare(`SELECT at,label,intensity,valence,arousal ${base}`).all(r.id, fromN, toN, cap)
        }
        return rows.map(timelineRow)
      } catch {
        return []
      }
    },
    emotion: {
      state() {
        try {
          const c = conn()
          const r = row()
          if (!c || !r) throw new PersonaError(E.DB_UNAVAILABLE, 'persona.db 不可用')
          ensureState(c, r.id)
          const now = Date.now()
          const view = currentState(c, r.id, now, cfg.emotion)
          // 2026-11-13：state() 返回“有效情绪”（最强 active episode 优先），
          // 而不是只看 valence 衰减出来的 raw label；否则工具/GUI 永远显示“平静”。
          const episodes = activeEpisodes(c, r.id, now)
          const composed = composeEmotionView(view, episodes, { now, labelHalfLifeMinutes: cfg?.emotion?.labelHalfLifeMinutes })
          return {
            valence: view.valence,
            arousal: view.arousal,
            certainty: view.certainty,
            label: composed.label,
            intensity: composed.intensity,
            stateLabel: view.label,
            stateIntensity: view.intensity,
            episode: composed.episode ? { emotion: composed.episode.emotion, intensity: composed.episode.intensity, target: composed.episode.target, cause: composed.episode.cause, at: composed.episode.at } : null,
            dominance: view.dominance,
            moodValence: view.moodValence,
            moodArousal: view.moodArousal,
            energy: view.energy,
            social: view.social,
            updatedAt: view.updatedAt,
          }
        } catch {
          return {
            valence: 0,
            arousal: 0.2,
            certainty: 0.5,
            label: '平静',
            intensity: 0.2,
            energy: 0.7,
            social: 0.7,
            updatedAt: 0,
            degraded: true,
          }
        }
      },
      toneHint() {
        try {
          const c = conn()
          const r = row()
          if (!c || !r) return ''
          const view = currentState(c, r.id, Date.now(), cfg.emotion)
          return toneHintOf(view)
        } catch {
          return ''
        }
      },
      why(hours = 6, opts = {}) {
        const header = headerFromOpts(opts)
        assertOwnerCall(header, cfg) // 无 header / 子智能体 / 群聊 / 白名单外 → E_PERMISSION
        const h = Number(hours)
        if (!Number.isFinite(h) || h <= 0 || h > 24 * 30) throw new PersonaError(E.INVALID_ARG, 'hours 需在 (0,720]')
        const includeTrigger = opts.includeTrigger !== false && Number(cfg?.emotion?.triggerMaxChars ?? 60) > 0
        const c = conn()
        const r = row()
        if (!c || !r) return { points: [] }
        return { points: whyRows(c, r.id, h, { includeTrigger, limit: Number(opts.limit ?? 3), now: Date.now() }) }
      },
    },
    /** 注入用：当前情绪行（内部用，不在契约里） */
    _emotionLine() {
      try {
        const c = conn()
        const r = row()
        if (!c || !r) return ''
        const view = currentState(c, r.id, Date.now(), cfg.emotion)
        return emotionLine(view, { threshold: Number(cfg?.emotion?.threshold ?? 0.35) })
      } catch {
        return ''
      }
    },
    /**
     * 注入用：按会话场景出情绪行（内部用）。
     * - 群聊：永远粗粒度（只标签，不暴露主人相关细节/语气原因）；
     * - 渠道私聊（QQ 房间等）：强度低于阈值时退化为粗粒度，保证情绪行不整块消失；
     * - home/owner：沿用旧阈值行为。
     */
    /** 情绪行为提示：标签之外再给一句“这轮怎么说话”的指令（2026-11-13）。 */
    _emotionActFor(header) {
      try {
        const c = conn()
        const r = row()
        if (!c || !r) return ''
        const h = headerOf(header)
        const kind = classify(h, cfg)
        if (kind === 'group') return ''
        const now = Date.now()
        const view = currentState(c, r.id, now, cfg.emotion)
        const episodes = activeEpisodes(c, r.id, now)
        const composed = composeEmotionView(view, episodes, { now, labelHalfLifeMinutes: cfg?.emotion?.labelHalfLifeMinutes })
        // 优先用最近一次 LLM appraisal 的表达策略（30 分钟内），否则退回标签行为提示
        try {
          const row = c.prepare('SELECT strategy_json,strategy_at FROM emotion_state WHERE self_id=?').get(r.id)
          if (row?.strategy_json && Number(row.strategy_at) > now - 30 * 60 * 1000) {
            const st = JSON.parse(String(row.strategy_json))
            const t = strategyText({ strategy: st })
            if (t) return t
          }
        } catch {}
        return emotionActHint(composed.label, composed.intensity, { threshold: Number(cfg?.emotion?.threshold ?? 0.25) })
      } catch { return '' }
    },

    _emotionLineFor(header) {
      try {
        const c = conn()
        const r = row()
        if (!c || !r) return ''
        const h = headerOf(header)
        const now = Date.now()
        const view = currentState(c, r.id, now, cfg.emotion)
        const kind = classify(h, cfg)
        const coarse = kind === 'group'
        const always = !coarse && isChannelCwd(h?.cwd, cfg)
        // 2026-11-12：label 合成 = 最强活跃 episode → mood 调和的 valence（P0-1）；
        // P0（本轮）：episode 标签按 emotion.labelHalfLifeMinutes（默认 45min）半衰，
        // 超过一个半衰期回落到 valence，避免一个标签挂一天。
        const episodes = coarse ? [] : activeEpisodes(c, r.id, now)
        const composed = composeEmotionView(view, episodes, {
          now,
          labelHalfLifeMinutes: cfg?.emotion?.labelHalfLifeMinutes,
        })
        const shown = { ...view, label: composed.label, intensity: composed.intensity }
        const line = emotionLineFor(shown, {
          threshold: Number(cfg?.emotion?.threshold ?? 0.35),
          coarse,
          always,
        })
        const episode = coarse ? null : composed.episode
        if (!episode) return line
        const templates = {
          'concern:owner': '有点担心你，累了就早点休息。',
          'affection:owner': '被夸得有点开心。',
          'joy:owner': '被夸得有点开心。',
          'worry:owner': '有点想你。',
          'loneliness:owner': '有点想你。',
          'frustration:tool': '这个工具又卡了，有点烦。',
          'fatigue:self': '我有点累。',
          'sadness:self': '有点难过。',
          'anger:self': '有点生气。',
          'anxiety:self': '有点慌。',
          'relief:self': '心里踏实了一点。',
        }
        const suffix = templates[`${episode.emotion}:${episode.target}`]
        if (!suffix) return line
        // 强度低于阈值时 emotionLine 为空：只给 episode 那句情绪描述，但硬约束句不能丢
        if (!line) return `【你现在的情绪】${suffix}${EMOTION_RULE}`
        // 硬约束句固定在行尾：episode 补充句插在它前面，避免出现「。；」和规则句重复
        if (line.endsWith(EMOTION_RULE)) {
          return `${line.slice(0, -EMOTION_RULE.length).replace(/。$/, '')}；${suffix}${EMOTION_RULE}`
        }
        return `${line.replace(/。$/, '')}；${suffix}`
      } catch {
        return ''
      }
    },
  }
}
