/** 给汐自己的工具：身份、改名、人格、情绪、溯源。 */
import { PersonaError, E } from './db.js'
import { nameHistory, renameSelf, syncPersonaVersion } from './self.js'
import { readPersonaFile, renderPersona, sectionText } from './persona.js'
import { ensureState, timeline, points } from './emotion.js'
import { assertOwnerCall, headerOf, isSubagent } from './scope.js'
import { openGrievance, listGrievances, resolveGrievance } from './grievance.js'
import { listAxes, nudgeAxis, AXES } from './axes.js'

const OUT = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
  required: ['ok', 'detail'],
  additionalProperties: false,
}
const pack = (obj) => ({ ok: obj?.ok !== false, detail: JSON.stringify(obj, null, 2) })
const render = (_a, v) => [{ type: 'text', text: v.detail }]

function fail(code, message) {
  return pack({ ok: false, error: code, message })
}

export function registerTools({ tools, cfg, state, log }) {
  const reg = (def) => {
    try {
      tools.register(def)
    } catch (error) {
      log.warn?.(`[persona] 注册 ${def.name} 失败：${error?.message ?? error}`)
    }
  }
  const requireSelf = () => {
    if (!state.self) throw new PersonaError(E.DB_UNAVAILABLE, 'self 不可用（启动冲突或 DB 未打开）')
    return state.self
  }
  const headerFromExec = (exec) => headerOf(exec?.agent ?? exec)

  reg({
    name: 'dy_persona_whoami',
    description: '返回稳定 ID、当前名字、人格版本与名字版本。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async () => {
      try {
        const self = requireSelf()
        return pack({
          ok: true,
          self_id: self.id,
          display_name: self.display_name,
          persona_version: Number(self.persona_version ?? 1),
          name_version: Number(self.name_version ?? 0),
          inject_mode: cfg.inject.mode,
          allowlisted: cfg.inject.sessionDirs.length,
        })
      } catch (error) {
        return fail(error.code ?? 'E_PERSONA_UNAVAILABLE', error.message)
      }
    },
  })

  reg({
    name: 'dy_persona_rename',
    description: '给自己改显示名；self_id、人格版本、记忆与情绪数据都不变。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, reason: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args, exec) => {
      try {
        if (isSubagent(headerFromExec(exec))) return fail(E.PERMISSION, '子智能体不能改名')
        const self = requireSelf()
        const row = renameSelf(state.db, self.id, args?.name, { reason: String(args?.reason ?? ''), source: 'tool' })
        state.self = row
        return pack({ ok: true, self_id: row.id, display_name: row.display_name, name_version: row.name_version, unchanged: row.unchanged === true })
      } catch (error) {
        return fail(error.code ?? 'E_INVALID_ARG', error.message)
      }
    },
  })

  reg({
    name: 'dy_persona_get',
    description: '读人格核心：给 section 读某一节（如「说话方式」），不给读全文（已渲染当前名字）。',
    parameters: {
      type: 'object',
      properties: { section: { type: 'string' } },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args) => {
      try {
        const raw = readPersonaFile(cfg.personaPath)
        if (!raw.trim()) return pack({ ok: true, text: '', empty: true })
        const name = state.self?.display_name ?? ''
        const section = String(args?.section ?? '').trim()
        if (section) {
          const text = sectionText(raw, section, name)
          return pack({ ok: text !== '', text, section, missing: text === '' })
        }
        return pack({ ok: true, text: renderPersona(raw, name).trim(), version: Number(state.self?.persona_version ?? 1) })
      } catch (error) {
        return fail(error.code ?? 'E_INVALID_ARG', error.message)
      }
    },
  })

  reg({
    name: 'dy_persona_history',
    description: '名字变更历史（含原因与来源）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async () => {
      try {
        const self = requireSelf()
        return pack({ ok: true, history: nameHistory(state.db, self.id) })
      } catch (error) {
        return fail(error.code ?? 'E_PERSONA_UNAVAILABLE', error.message)
      }
    },
  })

  reg({
    name: 'dy_emotion_state',
    description: '当前高兴/激动/确定程度、标签、强度（数值仅供自查，注入里不带数字）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async () => {
      try {
        const self = requireSelf()
        ensureState(state.db, self.id)
        const view = state.service?.emotion?.state?.() ?? {}
        return pack({ ok: true, self_id: self.id, ...view })
      } catch (error) {
        return fail(error.code ?? 'E_PERSONA_UNAVAILABLE', error.message)
      }
    },
  })

  reg({
    name: 'dy_emotion_timeline',
    description: '最近若干小时的情绪曲线（不含触发正文）。',
    parameters: { type: 'object', properties: { hours: { type: 'number' } }, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async (args) => {
      try {
        const self = requireSelf()
        return pack({ ok: true, rows: timeline(state.db, self.id, Number(args?.hours) || 24) })
      } catch (error) {
        return fail(error.code ?? 'E_PERSONA_UNAVAILABLE', error.message)
      }
    },
  })

  reg({
    name: 'dy_emotion_points',
    description: '情绪转折点（含触发句截断与消息引用）。',
    parameters: { type: 'object', properties: { hours: { type: 'number' } }, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async (args) => {
      try {
        const self = requireSelf()
        return pack({ ok: true, rows: points(state.db, self.id, Number(args?.hours) || 24) })
      } catch (error) {
        return fail(error.code ?? 'E_PERSONA_UNAVAILABLE', error.message)
      }
    },
  })

  reg({
    name: 'dy_emotion_why',
    description: '最近情绪变化的原因链：哪句话让她变了、变化多少、消息引用。只给规则归因。',
    parameters: {
      type: 'object',
      properties: { hours: { type: 'number' }, include_trigger: { type: 'boolean' } },
      additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args, exec) => {
      try {
        const header = headerFromExec(exec)
        const pointsOut = state.service?.emotion?.why?.(Number(args?.hours) || 6, {
          includeTrigger: args?.include_trigger !== false,
          header,
        })?.points ?? []
        return pack({ ok: true, points: pointsOut, note: '规则归因，不是心理分析' })
      } catch (error) {
        if (error instanceof PersonaError || error?.code) return fail(error.code ?? E.PERMISSION, error.message)
        return fail(E.PERMISSION, '无权读取情绪溯源')
      }
    },
  })

  reg({
    name: 'dy_persona_axes',
    description: '看/推性格底色（嘴硬/温柔/主动/克制）：list 查看；nudge 单次最多 ±0.03。只有主人/家可用；默认不注入。',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'nudge'] }, axis: { type: 'string', enum: AXES }, delta: { type: 'number' } },
      required: ['action'], additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args, exec) => {
      try {
        const header = headerFromExec(exec)
        if (isSubagent(header)) return fail(E.PERMISSION, '子智能体不能用性格底色')
        assertOwnerCall(header, cfg)
        const self = requireSelf()
        if (String(args?.action) === 'list') return pack({ ok: true, axes: listAxes(state.db, self.id), enabled: cfg.virtue?.enabled === true })
        if (String(args?.action) === 'nudge') return pack({ ok: true, ...nudgeAxis(state.db, self.id, args?.axis, Number(args?.delta) || 0) })
        return fail(E.INVALID_ARG, 'action 只能是 list/nudge')
      } catch (error) { return fail(error.code ?? 'E_INVALID_ARG', error.message) }
    },
  })

  reg({
    name: 'dy_persona_grievance',
    description: '关系矛盾账本：list 看还没说开的事；open 记一条；resolve 标为已说开。只有主人/家可用。',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'open', 'resolve'] }, cause: { type: 'string' }, id: { type: 'number' }, note: { type: 'string' } },
      required: ['action'], additionalProperties: false,
    },
    output: { schema: OUT, render },
    execute: async (args, exec) => {
      try {
        const header = headerFromExec(exec)
        if (isSubagent(header)) return fail(E.PERMISSION, '子智能体不能用矛盾账本')
        assertOwnerCall(header, cfg)
        const self = requireSelf()
        const action = String(args?.action ?? 'list')
        if (action === 'list') return pack({ ok: true, items: listGrievances(state.db, self.id, { limit: 10 }) })
        if (action === 'open') {
          const r = openGrievance(state.db, self.id, { cause: String(args?.cause ?? ''), note: String(args?.note ?? '') })
          if (!r) return fail(E.INVALID_ARG, 'cause 不能为空')
          return pack({ ok: true, ...r })
        }
        if (action === 'resolve') {
          const r = resolveGrievance(state.db, self.id, Number(args?.id), { note: String(args?.note ?? '') })
          return pack({ ok: true, ...r })
        }
        return fail(E.INVALID_ARG, 'action 只能是 list/open/resolve')
      } catch (error) {
        return fail(error.code ?? 'E_INVALID_ARG', error.message)
      }
    },
  })

  reg({
    name: 'dy_persona_mode',
    description: '查看当前注入档位与白名单命中情况（只读；改配置需重启）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render },
    execute: async (_args, exec) => {
      try {
        const header = headerFromExec(exec)
        const block = state.service?.block?.() ?? { mode: cfg.inject.mode, text: '' }
        return pack({
          ok: true,
          mode: cfg.inject.mode,
          resolved: assertOwnerCall(header, cfg) ? 'owner-callable' : 'unknown',
          block_len: String(block.text ?? '').length,
          allowlisted: cfg.inject.sessionDirs.length,
          emotion_ingest: cfg.emotion.ingestEnabled,
          emotion_threshold: cfg.emotion.threshold,
          emotion_stats: state.emoStats?.() ?? null,
        })
      } catch (error) {
        return pack({ ok: true, mode: cfg.inject.mode, resolved: error.code ?? 'denied', block_len: 0, allowlisted: cfg.inject.sessionDirs.length })
      }
    },
  })

}
