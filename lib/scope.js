/**
 * 会话范围与权限判定。
 *
 * 契约 v1.0 §4：
 * - 子智能体（parentSession / origin='subagent' / delegationDepth>0）直接拒绝
 * - 群聊、白名单外不注入、不返回 owner 数据
 *
 * 所有判定只看 header 与会话目录名，**不看 QQ 号**。
 */
import { PersonaError, E } from './db.js'

export const SCOPES = { PRIVATE: 'private', GROUP: 'group', SUBAGENT: 'subagent', UNKNOWN: 'unknown' }

export function headerOf(agentOrHeader) {
  if (!agentOrHeader) return {}
  if (agentOrHeader.session?.header) return agentOrHeader.session.header
  if (agentOrHeader.header) return agentOrHeader.header
  return agentOrHeader
}

/**
 * 契约 §4 的严格判据（可见性轴用）：`parentSession` 也算——主人数据不因 fork 放开。
 */
export function isSubagent(header) {
  const h = headerOf(header)
  return h.parentSession !== undefined || h.origin === 'subagent' || Number(h.delegationDepth ?? 0) > 0
}

/**
 * 身份轴判据（D2）：只有真子智能体才排除。
 * 宿主 GUI `session/fork` 只写 `parentSession + isSeeded + agentPreset`，**不写 origin/depth**
 * （证据：`dsh-api-session-controller/lib/index.js:849-900`、`dsh-session/lib/index.js:2013-2024`）；
 * 真子智能体会写 `origin='subagent'` 且 `delegationDepth>=1`（本机会话 header 实证）。
 * 所以 `parentSession` 单独出现 → fork=她的正常会话；只有 origin/depth 才判子智能体。
 */
export function isDelegatedSubagent(header) {
  const h = headerOf(header)
  return h.origin === 'subagent' || Number(h.delegationDepth ?? 0) > 0
}

function baseName(p) {
  const s = String(p ?? '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}

/**
 * 群聊判定：不依赖 QQ 号，三种都认——
 * 1) basename 以配置前缀开头（默认 `群_`，兼容旧目录）；
 * 2) basename 以 `qq-群` 开头（桥 0.18 的群目录命名）；
 * 3) 路径里含 `/qq-群/` 段（当前真实结构：/sdcard/DSHA/渠道/qq-群/<群号>）。
 */
export function isGroupDir(cwd, prefix = '群_') {
  const p = String(prefix || '群_')
  const base = baseName(cwd)
  const full = String(cwd ?? '').replaceAll('\\', '/')
  return (
    base.startsWith(p) ||
    base.startsWith('qq-群') ||
    /(^|\/)qq-群(\/|$)/.test(full)
  )
}

export function classify(header, { groupDirPrefix = '群_' } = {}) {
  const h = headerOf(header)
  if (isDelegatedSubagent(h)) return SCOPES.SUBAGENT
  if (!h.cwd) return SCOPES.UNKNOWN
  if (isGroupDir(h.cwd, groupDirPrefix)) return SCOPES.GROUP
  return SCOPES.PRIVATE
}

/** sessionDirs 归一化：字符串或 {dir, mode}。 */
export function normalizeDirs(sessionDirs) {
  if (!Array.isArray(sessionDirs)) return []
  const out = []
  for (const entry of sessionDirs) {
    if (typeof entry === 'string' && entry.trim()) out.push({ dir: entry.trim(), mode: null })
    else if (entry && typeof entry === 'object' && entry.dir) {
      const mode = entry.mode === undefined || entry.mode === null ? null : String(entry.mode)
      out.push({ dir: String(entry.dir), mode })
    }
  }
  return out.sort((a, b) => b.dir.length - a.dir.length)
}

/**
 * cwd 是否落在某个目录前缀下（按 `/` 边界；保留旧的宽松 startsWith 兼容）。
 * 身份轴（bind.cwdPrefixes）与可见性轴（inject.sessionDirs）共用同一套匹配语义。
 */
export function cwdInDir(cwd, dir) {
  const c = String(cwd ?? '')
  const d = String(dir ?? '')
  if (!c || !d) return false
  return c === d || c.startsWith(d.endsWith('/') ? d : `${d}/`) || c.startsWith(d)
}

/**
 * 渠道目录判定（QQ 房间等）：这些会话的情绪行即使强度低于阈值也至少给粗粒度，
 * 避免「人格在、情绪块整块消失」。目录来自 `inject.channelDirs`（默认 /sdcard/DSHA/渠道）。
 */
export function isChannelCwd(cwd, cfg) {
  const c = String(cwd ?? '')
  if (!c) return false
  return normalizeDirs(cfg?.inject?.channelDirs).some((d) => cwdInDir(c, d.dir))
}

/**
 * 最长前缀匹配。
 * @returns {{allow:boolean, mode:string, dir:string|null, reason:string}}
 */
export function resolveScope(header, cfg) {
  const h = headerOf(header)
  const kind = classify(h, cfg)
  if (kind === SCOPES.SUBAGENT) return { allow: false, mode: 'off', dir: null, reason: 'subagent' }
  if (kind === SCOPES.GROUP) return { allow: false, mode: 'off', dir: null, reason: 'group' }
  const cwd = String(h.cwd ?? '')
  if (!cwd) return { allow: false, mode: 'off', dir: null, reason: 'no-cwd' }

  const dirs = normalizeDirs(cfg?.inject?.sessionDirs)
  if (!dirs.length) return { allow: false, mode: 'off', dir: null, reason: 'empty-allowlist' }
  const hit = dirs.find((d) => cwdInDir(cwd, d.dir))
  if (!hit) return { allow: false, mode: 'off', dir: null, reason: 'not-allowlisted' }
  const mode = hit.mode || cfg?.inject?.mode || 'off'
  return { allow: mode !== 'off', mode, dir: hit.dir, reason: 'allowlisted' }
}

/**
 * 只算注入档位（不看是否有资格）：per-dir 覆盖优先，其次全局 mode。
 * 身份轴 binding 命中时用它决定 full/brief；off 表示不注入。
 */
export function resolveMode(header, cfg) {
  const h = headerOf(header)
  const cwd = String(h.cwd ?? '')
  const hit = normalizeDirs(cfg?.inject?.sessionDirs).find((d) => cwdInDir(cwd, d.dir))
  return hit?.mode || cfg?.inject?.mode || 'off'
}

/** 场景键：group / channel / home（home 兜底 owner 与其它白名单） */
export function scopeKey(header, cfg) {
  const h = headerOf(header)
  if (classify(h, cfg) === SCOPES.GROUP) return 'group'
  if (isChannelCwd(h?.cwd, cfg)) return 'channel'
  return 'home'
}

/**
 * brief 预算：`inject.budgetByScope[场景]` 优先（必须是正数），否则 `inject.briefBudgetChars`。
 * 默认 budgetByScope={} → 所有场景同旧值（行为不变）。full 档不用 budget。
 */
export function resolveInjectBudget(header, cfg) {
  const key = scopeKey(header, cfg)
  const byScope = cfg?.inject?.budgetByScope
  const raw = byScope && typeof byScope === 'object' ? byScope[key] : undefined
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n
  return Number(cfg?.inject?.briefBudgetChars ?? 250)
}

/** 敏感方法（emotion.why）的调用权限：**无 header 一律拒绝**（契约 v1.1 §4）。 */
export function assertOwnerCall(header, cfg) {
  if (header === undefined || header === null) {
    throw new PersonaError(E.PERMISSION, '服务调用必须带 header（E_PERMISSION）')
  }
  // 可见性轴沿用契约 §4 的严格判据：parentSession（含 fork）也不返回 owner 数据。
  if (isSubagent(header)) {
    throw new PersonaError(E.PERMISSION, '子智能体不能读取情绪溯源（E_PERMISSION）')
  }
  const kind = classify(header, cfg)
  if (kind === SCOPES.GROUP) {
    throw new PersonaError(E.PERMISSION, '群聊不返回情绪溯源（E_PERMISSION）')
  }
  const scope = resolveScope(header, cfg)
  if (!scope.allow) {
    const why = cfg?.inject?.sessionDirs?.length ? '白名单外' : '白名单未配置'
    throw new PersonaError(E.PERMISSION, `${why}，不返回情绪溯源（E_PERMISSION）`)
  }
  return true
}
