/** 测试夹具：全部用合成数据（不含真实人格正文、不含真实 QQ 号）。 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const FIXTURE_PERSONA = `# 我是谁

名字：{{display_name}}
身份：测试用鲸鱼娘，独立人格。

# 性格

- 说话直，不绕圈
- 被夸会应下来

# 说话方式

- 口语、短句
- 不用表格
- 不写报告

# 边界

- 不编造记忆
`

export function tmpDir(prefix = 'persona-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function writeFixturePersona(dir, content = FIXTURE_PERSONA) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'persona.md')
  writeFileSync(path, content, 'utf8')
  return path
}

/** 造一个 v1 骨架库（字段与现有骨架一致），用于验证迁移。 */
export function makeV1Db(path) {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS self (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      persona_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS name_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, self_id TEXT NOT NULL,
      old_name TEXT, new_name TEXT NOT NULL, reason TEXT, changed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS persona_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, self_id TEXT NOT NULL,
      version INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(self_id, version)
    );
    CREATE TABLE IF NOT EXISTS emotion_state (
      self_id TEXT PRIMARY KEY, valence REAL NOT NULL DEFAULT 0,
      arousal REAL NOT NULL DEFAULT 0, certainty REAL NOT NULL DEFAULT 0.5,
      label TEXT NOT NULL DEFAULT '平静', intensity REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS emotion_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT, self_id TEXT NOT NULL, at INTEGER NOT NULL,
      valence REAL NOT NULL, arousal REAL NOT NULL, label TEXT NOT NULL, source TEXT
    );
    CREATE TABLE IF NOT EXISTS emotion_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT, self_id TEXT NOT NULL, at INTEGER NOT NULL,
      dimension TEXT NOT NULL, delta REAL NOT NULL, reason TEXT, source_seq INTEGER
    );
    CREATE TABLE IF NOT EXISTS emotion_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, self_id TEXT NOT NULL,
      action TEXT NOT NULL, before_json TEXT, after_json TEXT, note TEXT
    );
  `)
  const at = Date.now()
  db.prepare("INSERT INTO self(id,display_name,persona_version,status,created_at,updated_at) VALUES('self:v1-fixture','汐',3,'active',?,?)").run(at, at)
  db.prepare("INSERT INTO name_history(self_id,old_name,new_name,reason,changed_at) VALUES('self:v1-fixture','小汐','汐','测试',?)").run(at)
  db.prepare("INSERT INTO emotion_state(self_id,valence,arousal,certainty,label,intensity,updated_at) VALUES('self:v1-fixture',0.3,0.4,0.5,'开心',0.4,?)").run(at)
  db.prepare("INSERT INTO emotion_timeline(self_id,at,valence,arousal,label,source) VALUES('self:v1-fixture',?,0.3,0.4,'开心','rule')").run(at)
  db.prepare("INSERT INTO emotion_points(self_id,at,dimension,delta,reason,source_seq) VALUES('self:v1-fixture',?,'valence',0.2,'测试',1)").run(at)
  return db
}

/** 造一个假 cordis ctx：provide/get/on/emit + 可选 tools/systemPrompt。 */
export function makeCtx(initial = {}) {
  const services = new Map(Object.entries(initial))
  const listeners = new Map()
  const logLines = []
  const ctx = {
    logger: {
      info: (...a) => logLines.push(['info', a.join(' ')]),
      warn: (...a) => logLines.push(['warn', a.join(' ')]),
      error: (...a) => logLines.push(['error', a.join(' ')]),
    },
    get: (name) => services.get(name),
    provide: (name, value, check) => {
      if (typeof value === 'function' && check === undefined) throw new Error('provide 需要值')
      services.set(name, value)
      return () => services.delete(name)
    },
    on: (event, fn) => {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {
        const cur = listeners.get(event) ?? []
        listeners.set(event, cur.filter((f) => f !== fn))
      }
    },
    emit: (event, ...args) => {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    agents: { list: () => [] },
    _services: services,
    _logs: logLines,
  }
  return ctx
}

/** 假 agent：session.header + 每 agent 自己的 systemPrompt.context 收集器。 */
export function makeAgent({ id = 'sess-test', cwd = '/tmp/conv', header = {}, systemPrompt } = {}) {
  const registered = []
  const ctx = {
    systemPrompt: systemPrompt ?? {
      context(def) {
        if (registered.some((r) => r.name === def.name)) {
          throw new Error(`prompt context "${def.name}" is already registered in this scope`)
        }
        registered.push(def)
        return () => {
          const i = registered.findIndex((r) => r.name === def.name)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    },
  }
  return { session: { header: { id, cwd, ...header } }, ctx, _registered: registered }
}

/** 假 tools 注册表。 */
export function makeTools() {
  const defs = new Map()
  return {
    register(def) {
      if (defs.has(def.name)) throw new Error(`tool ${def.name} already registered`)
      defs.set(def.name, def)
    },
    list: () => [...defs.values()],
    get: (n) => defs.get(n),
    _defs: defs,
  }
}

/** 起一个插件实例（假 ctx），返回服务/工具/日志，便于 smoke。 */
export async function bootPlugin({ cfg = {}, agents = [] } = {}) {
  const { apply } = await import('../../lib/index.js')
  const { dirname } = await import('node:path')
  // 没给 dataDir 时，跟 personaPath 放同一个临时目录，避免库和人格文件分家
  const dir = cfg.dataDir ?? (cfg.personaPath ? dirname(cfg.personaPath) : tmpDir())
  const personaPath = cfg.personaPath ?? writeFixturePersona(dir)
  const tools = makeTools()
  const ctx = makeCtx({ tools })
  ctx.agents = { list: () => agents }
  apply(ctx, { dataDir: dir, dbPath: join(dir, 'persona.db'), personaPath, ...cfg })
  return {
    ctx,
    tools,
    service: ctx.get('dyPersona'),
    logs: ctx._logs,
    dir,
    personaPath,
    emit: (event, ...args) => ctx.emit(event, ...args),
  }
}
