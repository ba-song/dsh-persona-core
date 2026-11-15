/**
 * 身份轴（批次 D）：`session_bindings` 的建表、写入与读取。
 *
 * 规则（与 2026-11-02 实现的表结构一致，表里没有 mode 列，档位仍按
 * 注入配置的 per-dir 覆盖 / 全局 mode 解析）：
 * - 只在 cwd 命中 `bind.cwdPrefixes`（默认=inject.sessionDirs）时写入 persona 绑定；
 * - 写入幂等：同一 session_id 只保留一行；同 persona 时刷新 role/cwd/source，
 *   **不覆盖不同 persona 的旧行、不改 created_at**（旧数据只增不改）；
 * - 读不到/表不可用一律返回 null，调用方按 cwd 白名单降级；
 * - 子智能体/群聊的拒绝在调用方（inject.mount）先做，binding 不凌驾契约 §4。
 */
import { cwdInDir, normalizeDirs } from './scope.js'

export const ROLE_PERSONA = 'persona'
export const ROLE_WORK = 'work'
export const SOURCE_DEFAULT = 'default'

/** 幂等建表：表已存在时是 no-op；失败只影响身份轴，不阻断插件启动。 */
export function ensureBindingsTable(db) {
  if (!db) return false
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_bindings (
      session_id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      role TEXT NOT NULL,
      cwd TEXT,
      source TEXT,
      created_at INTEGER NOT NULL
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS ix_session_bindings_role ON session_bindings(role)')
    return true
  } catch {
    return false
  }
}

/** 绑定的 cwd 前缀：`bind.cwdPrefixes` 非空用它，否则跟随 `inject.sessionDirs`。 */
export function bindingPrefixes(cfg) {
  if (cfg?.bind?.enabled === false) return []
  const raw = Array.isArray(cfg?.bind?.cwdPrefixes) && cfg.bind.cwdPrefixes.length
    ? cfg.bind.cwdPrefixes
    : cfg?.inject?.sessionDirs
  return normalizeDirs(raw)
}

/** cwd 是否命中可写绑定的前缀。 */
export function cwdBindable(cwd, cfg) {
  const s = String(cwd ?? '')
  if (!s) return false
  return bindingPrefixes(cfg).some((d) => cwdInDir(s, d.dir))
}

/** 读一行绑定（表不存在/库不可用返回 null，不抛）。 */
export function getBinding(db, sessionId) {
  if (!db || !sessionId) return null
  try {
    return db.prepare('SELECT * FROM session_bindings WHERE session_id=?').get(String(sessionId)) ?? null
  } catch {
    return null
  }
}

/**
 * 该会话是否有可用的人格绑定：role=persona 且 persona_id 等于当前 self。
 * 指向别的 persona 的行视为「未命中」，调用方再按 cwd 白名单降级。
 */
export function personaBindingOf(db, sessionId, personaId) {
  const row = getBinding(db, sessionId)
  if (!row) return null
  if (row.role !== ROLE_PERSONA) return null
  if (!personaId || row.persona_id !== String(personaId)) return null
  return row
}

/**
 * 写入/刷新绑定（幂等）。返回写入后的行；失败返回 null（不抛）。
 * - 同 session + 同 persona：刷新 role/cwd/source，保留 created_at
 * - 同 session + 不同 persona：不动旧行（避免把 11-02 的旧绑定覆盖掉）
 */
export function bindSession(db, { sessionId, personaId, role = ROLE_PERSONA, cwd = '', source = SOURCE_DEFAULT, now = Date.now() } = {}) {
  if (!db || !sessionId || !personaId) return null
  try {
    db.prepare(
      `INSERT INTO session_bindings(session_id, persona_id, role, cwd, source, created_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         role=excluded.role, cwd=excluded.cwd, source=excluded.source
       WHERE session_bindings.persona_id = excluded.persona_id`,
    ).run(String(sessionId), String(personaId), String(role), String(cwd ?? ''), String(source), Number(now))
    return getBinding(db, sessionId)
  } catch {
    return null
  }
}
