/** 矛盾账本（2026-11-12）：关系里没当场说开的事，记着但别每轮都翻。 */
export function ensureGrievanceTable(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS grievances (
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
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_grievance_self ON grievances(self_id, status)')
  } catch {}
}

export function openGrievance(db, selfId, { cause = '', severity = 0.5, at = Date.now(), note = '' } = {}) {
  const c = String(cause ?? '').trim().slice(0, 200)
  if (!c) return null
  ensureGrievanceTable(db)
  const existing = db.prepare("SELECT id,severity,repeat_count FROM grievances WHERE self_id=? AND status='open' AND cause=? ORDER BY id DESC LIMIT 1").get(String(selfId), c)
  if (existing) {
    db.prepare('UPDATE grievances SET severity=MIN(1,severity+0.1), repeat_count=repeat_count+1, last_at=?, note=? WHERE id=?')
      .run(Number(at), String(note ?? '').slice(0, 300), existing.id)
    return { id: Number(existing.id), repeated: true }
  }
  const r = db.prepare("INSERT INTO grievances(self_id,cause,status,severity,repeat_count,opened_at,last_at,note) VALUES(?,?,'open',?,1,?,?,?)")
    .run(String(selfId), c, Math.max(0.1, Math.min(1, Number(severity) || 0.5)), Number(at), Number(at), String(note ?? '').slice(0, 300))
  return { id: Number(r.lastInsertRowid), repeated: false }
}

export function listGrievances(db, selfId, { status = 'open', limit = 5 } = {}) {
  ensureGrievanceTable(db)
  try {
    return db.prepare('SELECT id,cause,severity,repeat_count,opened_at,last_at,note FROM grievances WHERE self_id=? AND status=? ORDER BY severity DESC, last_at DESC LIMIT ?')
      .all(String(selfId), String(status), Math.max(1, Math.min(Number(limit) || 5, 20)))
  } catch { return [] }
}

export function resolveGrievance(db, selfId, id, { note = '', at = Date.now() } = {}) {
  ensureGrievanceTable(db)
  const r = db.prepare("UPDATE grievances SET status='resolved', resolved_at=?, note=? WHERE id=? AND self_id=? AND status='open'")
    .run(Number(at), String(note ?? '').slice(0, 300), Number(id), String(selfId))
  return { ok: Number(r.changes) > 0 }
}
