/**
 * persona.db v2：主体、名字历史、人格快照、情绪四表。
 *
 * 设计要点（见实施方案 §1）：
 * - `self` 只允许一行 `status='active'`（唯一部分索引兜底）
 * - v1 骨架库用幂等 ALTER 补齐到 v2，不删旧列
 * - 所有写操作走单写事务（BEGIN IMMEDIATE），读不加锁
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

export const SCHEMA_VERSION = 2

/** 契约错误码（接口契约 v1.0 §5）。 */
export class PersonaError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'PersonaError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

export const E = {
  SELF_CONFLICT: 'E_SELF_CONFLICT',
  SELF_NOT_FOUND: 'E_SELF_NOT_FOUND',
  PERMISSION: 'E_PERMISSION',
  DB_UNAVAILABLE: 'E_PERSONA_UNAVAILABLE',
  INVALID_ARG: 'E_INVALID_ARG',
  BUSY: 'E_BUSY',
  TIMEOUT: 'E_TIMEOUT',
}

export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

function columnsOf(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name))
  } catch {
    return new Set()
  }
}

function tableExists(db, table) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
    return row !== undefined
  } catch {
    return false
  }
}

function addColumn(db, table, column, ddl) {
  if (!columnsOf(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

export function getMeta(db, key) {
  try {
    return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value
  } catch {
    return undefined
  }
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(String(key), String(value))
}

/** 建表（v2 全量），对新库直接生效；对老库由 migrateToV2 补齐。 */
function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS self (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      name_version INTEGER NOT NULL DEFAULT 0,
      persona_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS name_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      self_id TEXT NOT NULL,
      old_name TEXT,
      new_name TEXT NOT NULL,
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'tool',
      changed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS persona_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      self_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(self_id, version)
    );
    CREATE TABLE IF NOT EXISTS emotion_state (
      self_id TEXT PRIMARY KEY,
      valence REAL NOT NULL DEFAULT 0,
      arousal REAL NOT NULL DEFAULT 0.2,
      certainty REAL NOT NULL DEFAULT 0.5,
      label TEXT NOT NULL DEFAULT '平静',
      intensity REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'rule',
      energy REAL NOT NULL DEFAULT 0.7,
      social REAL NOT NULL DEFAULT 0.7,
      ess_updated_at INTEGER NOT NULL DEFAULT 0,
      dominance REAL NOT NULL DEFAULT 0.5,
      mood_valence REAL NOT NULL DEFAULT 0,
      mood_arousal REAL NOT NULL DEFAULT 0.2,
      mood_updated_at INTEGER NOT NULL DEFAULT 0,
      label_updated_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS emotion_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      self_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      valence REAL NOT NULL,
      arousal REAL NOT NULL,
      label TEXT NOT NULL,
      intensity REAL NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL DEFAULT '',
      msg_ref TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS emotion_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      self_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      dimension TEXT NOT NULL,
      delta REAL NOT NULL,
      value_after REAL NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL DEFAULT '',
      msg_ref TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS character_axes (
      self_id TEXT NOT NULL,
      axis TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0.5,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(self_id, axis)
    );
    CREATE TABLE IF NOT EXISTS grievances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      self_id TEXT NOT NULL,
      cause TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      severity REAL NOT NULL DEFAULT 0.5,
      repeat_count INTEGER NOT NULL DEFAULT 1,
      opened_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      resolved_at INTEGER,
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS emotion_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      self_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS emotion_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      self_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      emotion TEXT NOT NULL,
      intensity REAL NOT NULL,
      cause TEXT NOT NULL,
      target TEXT NOT NULL,
      half_life_s INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      appraisal_id INTEGER NOT NULL DEFAULT 0,
      msg_ref TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS emotion_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      self_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '',
      goal_congruence REAL NOT NULL DEFAULT 0,
      certainty REAL NOT NULL DEFAULT 0.5,
      novelty REAL NOT NULL DEFAULT 0.5,
      source_ref TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL DEFAULT 0.5
    );
    CREATE TABLE IF NOT EXISTS emotion_appraisal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      self_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      rule_id TEXT NOT NULL,
      emotion TEXT NOT NULL,
      intensity REAL NOT NULL,
      valence REAL NOT NULL DEFAULT 0,
      arousal REAL NOT NULL DEFAULT 0,
      cause TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.5,
      accepted INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'rule'
    );
  `)
  createIndexes(db)
}

/**
 * 建索引；返回失败项（老库脏数据会让唯一索引建不起来）。
 * @returns {{created:string[], failed:{name:string,reason:string}[]}}
 */
export function createIndexes(db) {
  const indexes = [
    ['ux_self_single_active', "CREATE UNIQUE INDEX IF NOT EXISTS ux_self_single_active ON self(status) WHERE status='active'"],
    ['ux_persona_versions_hash', 'CREATE UNIQUE INDEX IF NOT EXISTS ux_persona_versions_hash ON persona_versions(self_id, content_hash)'],
    ['ix_name_history_self', 'CREATE INDEX IF NOT EXISTS ix_name_history_self ON name_history(self_id, changed_at DESC)'],
    ['ix_emo_timeline', 'CREATE INDEX IF NOT EXISTS ix_emo_timeline ON emotion_timeline(self_id, at)'],
    ['ix_emo_points', 'CREATE INDEX IF NOT EXISTS ix_emo_points ON emotion_points(self_id, at)'],
    ['ix_emo_audit', 'CREATE INDEX IF NOT EXISTS ix_emo_audit ON emotion_audit(self_id, at)'],
    ['ix_emo_episodes_active', 'CREATE INDEX IF NOT EXISTS ix_emo_episodes_active ON emotion_episodes(self_id, target, expires_at)'],
    ['ix_emo_event_at', 'CREATE INDEX IF NOT EXISTS ix_emo_event_at ON emotion_event(self_id, at)'],
    ['ix_emo_appraisal_at', 'CREATE INDEX IF NOT EXISTS ix_emo_appraisal_at ON emotion_appraisal(self_id, at)'],
  ]
  const created = []
  const failed = []
  for (const [name, sql] of indexes) {
    try {
      db.exec(sql)
      created.push(name)
    } catch (error) {
      // 老库可能已有多行 active 或重复 hash：不阻断，ensureSelf 会抛冲突
      failed.push({ name, reason: String(error?.message ?? error) })
    }
  }
  return { created, failed }
}

/**
 * v1 骨架 → v2 幂等迁移：只加列，不删列、不改数据。
 * @returns {{from:number,to:number,added:string[]}}
 */
export function migrateToV2(db) {
  const added = []
  const has = (t) => tableExists(db, t)
  // 迁移自带的元数据表：老库可能没有
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')

  if (has('self')) {
    if (!columnsOf(db, 'self').has('name_version')) {
      db.exec("ALTER TABLE self ADD COLUMN name_version INTEGER NOT NULL DEFAULT 0")
      added.push('self.name_version')
    }
  }
  if (has('name_history')) {
    if (!columnsOf(db, 'name_history').has('source')) {
      db.exec("ALTER TABLE name_history ADD COLUMN source TEXT NOT NULL DEFAULT 'tool'")
      added.push('name_history.source')
    }
  }
  if (has('persona_versions')) {
    if (!columnsOf(db, 'persona_versions').has('content_hash')) {
      db.exec("ALTER TABLE persona_versions ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''")
      added.push('persona_versions.content_hash')
    }

  }
  if (has('emotion_state')) {
    const cols = columnsOf(db, 'emotion_state')
    if (!cols.has('confidence')) {
      db.exec('ALTER TABLE emotion_state ADD COLUMN confidence REAL NOT NULL DEFAULT 0')
      added.push('emotion_state.confidence')
    }
    if (!cols.has('source')) {
      db.exec("ALTER TABLE emotion_state ADD COLUMN source TEXT NOT NULL DEFAULT 'rule'")
      added.push('emotion_state.source')
    }
    if (!cols.has('certainty')) {
      db.exec('ALTER TABLE emotion_state ADD COLUMN certainty REAL NOT NULL DEFAULT 0.5')
      added.push('emotion_state.certainty')
    }
    for (const [col, ddl] of [
      ['energy', 'REAL NOT NULL DEFAULT 0.7'],
      ['social', 'REAL NOT NULL DEFAULT 0.7'],
      ['ess_updated_at', 'INTEGER NOT NULL DEFAULT 0'],
      ['dominance', 'REAL NOT NULL DEFAULT 0.5'],
      ['mood_valence', 'REAL NOT NULL DEFAULT 0'],
      ['mood_arousal', 'REAL NOT NULL DEFAULT 0.2'],
      ['mood_updated_at', 'INTEGER NOT NULL DEFAULT 0'],
      ['strategy_json', "TEXT NOT NULL DEFAULT ''"],
      ['strategy_at', 'INTEGER NOT NULL DEFAULT 0'],
      // 2026-11-12 P0：标签新鲜度（episode 标签半衰期的起算点）；旧库 ALTER 后回填
      ['label_updated_at', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!cols.has(col)) {
        db.exec(`ALTER TABLE emotion_state ADD COLUMN ${col} ${ddl}`)
        added.push(`emotion_state.${col}`)
      }
    }
    // 旧行回填：以现有 updated_at 作为精力/社交/标签的起算时间，避免一启动就按 0 起算
    db.exec('UPDATE emotion_state SET ess_updated_at=updated_at WHERE ess_updated_at=0')
    db.exec('UPDATE emotion_state SET label_updated_at=updated_at WHERE label_updated_at=0')
  }
  if (has('emotion_timeline')) {
    const cols = columnsOf(db, 'emotion_timeline')
    for (const [col, ddl] of [
      ['intensity', 'REAL NOT NULL DEFAULT 0'],
      ['trigger', "TEXT NOT NULL DEFAULT ''"],
      ['msg_ref', "TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (!cols.has(col)) {
        db.exec(`ALTER TABLE emotion_timeline ADD COLUMN ${col} ${ddl}`)
        added.push(`emotion_timeline.${col}`)
      }
    }
  }
  if (has('emotion_points')) {
    const cols = columnsOf(db, 'emotion_points')
    for (const [col, ddl] of [
      ['value_after', 'REAL NOT NULL DEFAULT 0'],
      ['trigger', "TEXT NOT NULL DEFAULT ''"],
      ['msg_ref', "TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (!cols.has(col)) {
        db.exec(`ALTER TABLE emotion_points ADD COLUMN ${col} ${ddl}`)
        added.push(`emotion_points.${col}`)
      }
    }
  }
  if (has('emotion_episodes')) {
    if (!columnsOf(db, 'emotion_episodes').has('appraisal_id')) {
      db.exec('ALTER TABLE emotion_episodes ADD COLUMN appraisal_id INTEGER NOT NULL DEFAULT 0')
      added.push('emotion_episodes.appraisal_id')
    }
  }
  if (has('emotion_audit')) {
    const cols = columnsOf(db, 'emotion_audit')
    if (!cols.has('before_json')) {
      db.exec('ALTER TABLE emotion_audit ADD COLUMN before_json TEXT')
      added.push('emotion_audit.before_json')
    }
    if (!cols.has('after_json')) {
      db.exec('ALTER TABLE emotion_audit ADD COLUMN after_json TEXT')
      added.push('emotion_audit.after_json')
    }
  }

  // 迁移后同样补齐索引（唯一索引失败时保留数据、由 ensureSelf 报冲突）
  const indexResult = createIndexes(db)
  setMeta(db, 'schema_version', String(SCHEMA_VERSION))

  // 记录「这次真正加了什么」，回滚据此精确撤销（老库缺失时回滚用静态兜底）
  let prev = { columns: [], indexes: [] }
  try {
    prev = JSON.parse(getMeta(db, 'v2_added') || '{"columns":[],"indexes":[]}')
  } catch {}
  setMeta(
    db,
    'v2_added',
    JSON.stringify({
      columns: [...new Set([...(prev.columns ?? []), ...added])],
      indexes: [...new Set([...(prev.indexes ?? []), ...indexResult.created])],
    }),
  )
  return { from: 1, to: SCHEMA_VERSION, added, indexes: indexResult }
}

/**
 * 打开/新建 persona.db，并保证 schema 至少为 v2。
 * @param {string} path
 */
export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA busy_timeout=5000')
  db.exec('PRAGMA foreign_keys=ON')
  createTables(db)
  migrateToV2(db)
  return db
}

/** 单写事务；失败回滚并抛原错误。 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw error
  }
}

export const _internal = { columnsOf, tableExists, getMeta }
