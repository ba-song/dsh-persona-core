/** 主体、改名、人格版本快照。全部写操作在单写事务内完成。 */
import { randomUUID } from 'node:crypto'
import { PersonaError, E, sha256, tx } from './db.js'

const now = () => Date.now()

/**
 * 保证恰好一行 active 主体。
 * - 0 行：复用一行 inactive（灾后恢复）或新建
 * - 1 行：返回
 * - >1 行：抛 E_SELF_CONFLICT（不猜、不自动挑一行）
 */
export function ensureSelf(db, seedName = '汐', seedId = null) {
  const active = db.prepare("SELECT * FROM self WHERE status='active'").all()
  if (active.length > 1) {
    throw new PersonaError(E.SELF_CONFLICT, `self 表有 ${active.length} 行 active，拒绝启动身份与注入`, {
      ids: active.map((r) => r.id),
    })
  }
  if (active.length === 1) return active[0]

  if (seedId) {
    const byId = db.prepare('SELECT * FROM self WHERE id=?').get(seedId)
    if (byId) {
      db.prepare("UPDATE self SET status='active', updated_at=? WHERE id=?").run(now(), seedId)
      return db.prepare('SELECT * FROM self WHERE id=?').get(seedId)
    }
  }

  const dormant = db.prepare('SELECT * FROM self ORDER BY created_at ASC LIMIT 1').get()
  if (dormant) {
    db.prepare("UPDATE self SET status='active', updated_at=? WHERE id=?").run(now(), dormant.id)
    return db.prepare('SELECT * FROM self WHERE id=?').get(dormant.id)
  }

  const id = seedId || `self:${randomUUID()}`
  const at = now()
  db.prepare(
    "INSERT INTO self(id,display_name,name_version,persona_version,status,created_at,updated_at) VALUES(?,?,0,1,'active',?,?)",
  ).run(id, String(seedName || '汐'), at, at)
  return db.prepare('SELECT * FROM self WHERE id=?').get(id)
}

/** 改名：只动 display_name / name_version / updated_at，不动 persona_version。 */
export function renameSelf(db, selfId, nextName, { reason = '', source = 'tool' } = {}) {
  const name = String(nextName ?? '').trim()
  if (!name) throw new PersonaError(E.INVALID_ARG, '名字不能为空')
  if (name.length > 40) throw new PersonaError(E.INVALID_ARG, '名字太长（≤40 字符）')

  return tx(db, () => {
    const row = db.prepare('SELECT * FROM self WHERE id=?').get(selfId)
    if (!row) throw new PersonaError(E.SELF_NOT_FOUND, 'self 不存在')
    if (row.display_name === name) {
      return { ...row, unchanged: true }
    }
    const at = now()
    db.prepare('UPDATE self SET display_name=?, name_version=name_version+1, updated_at=? WHERE id=?')
      .run(name, at, selfId)
    db.prepare('INSERT INTO name_history(self_id,old_name,new_name,reason,source,changed_at) VALUES(?,?,?,?,?,?)')
      .run(selfId, row.display_name, name, String(reason ?? ''), String(source || 'tool'), at)
    return { ...db.prepare('SELECT * FROM self WHERE id=?').get(selfId), unchanged: false }
  })
}

export function nameHistory(db, selfId) {
  return db.prepare('SELECT * FROM name_history WHERE self_id=? ORDER BY changed_at DESC, id DESC').all(selfId)
}

/**
 * 用 persona.md 原文同步人格版本。
 * hash 算的是**模板原文**：改名只改 display_name，原文不变 → hash 不变 → 版本不变。
 * @returns {{version:number,hash:string,bumped:boolean,changed:boolean}}
 */
export function syncPersonaVersion(db, selfId, rawContent) {
  const content = String(rawContent ?? '')
  const hash = sha256(content)
  const selfRow = db.prepare('SELECT * FROM self WHERE id=?').get(selfId)
  if (!selfRow) throw new PersonaError(E.SELF_NOT_FOUND, 'self 不存在')

  const latest = db.prepare('SELECT * FROM persona_versions WHERE self_id=? ORDER BY version DESC LIMIT 1').get(selfId)
  if (latest && latest.content_hash === hash) {
    return { version: latest.version, hash, bumped: false, changed: false }
  }

  return tx(db, () => {
    const base = latest ? latest.version : Number(selfRow.persona_version || 1)
    const version = latest ? latest.version + 1 : base
    const exists = db.prepare('SELECT id FROM persona_versions WHERE self_id=? AND version=?').get(selfId, version)
    if (!exists) {
      db.prepare('INSERT INTO persona_versions(self_id,version,content,content_hash,created_at) VALUES(?,?,?,?,?)')
        .run(selfId, version, content, hash, now())
    }
    if (Number(selfRow.persona_version) !== version) {
      db.prepare('UPDATE self SET persona_version=?, updated_at=? WHERE id=?').run(version, now(), selfId)
    }
    return { version, hash, bumped: Number(selfRow.persona_version) !== version, changed: true }
  })
}

export function personaVersions(db, selfId, limit = 20) {
  return db.prepare('SELECT id,version,content_hash,created_at FROM persona_versions WHERE self_id=? ORDER BY version DESC LIMIT ?')
    .all(selfId, limit)
}
