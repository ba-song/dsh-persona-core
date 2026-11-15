/** 德行/性格慢轴（2026-11-13，默认关）：短期事件不突变，单次 ±0.03。 */
export const AXES = ['嘴硬', '温柔', '主动', '克制']
export const AXIS_DEFAULTS = { 嘴硬: 0.55, 温柔: 0.5, 主动: 0.45, 克制: 0.5 }

export function ensureAxes(db, selfId) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS character_axes (
      self_id TEXT NOT NULL, axis TEXT NOT NULL, value REAL NOT NULL DEFAULT 0.5,
      updated_at INTEGER NOT NULL, PRIMARY KEY(self_id, axis))`)
    const ins = db.prepare('INSERT OR IGNORE INTO character_axes(self_id,axis,value,updated_at) VALUES(?,?,?,?)')
    for (const a of AXES) ins.run(String(selfId), a, Number(AXIS_DEFAULTS[a] ?? 0.5), Date.now())
  } catch {}
}

export function listAxes(db, selfId) {
  ensureAxes(db, selfId)
  try {
    const rows = db.prepare('SELECT axis,value,updated_at FROM character_axes WHERE self_id=? ORDER BY axis').all(String(selfId))
    return rows.map((r) => ({ axis: r.axis, value: Number(r.value), updatedAt: Number(r.updated_at) }))
  } catch { return [] }
}

/** 单次推动上限默认 0.03；返回新值。 */
export function nudgeAxis(db, selfId, axis, delta, { at = Date.now(), maxDelta = 0.03 } = {}) {
  const a = String(axis ?? '')
  if (!AXES.includes(a)) return { ok: false, code: 'BAD_AXIS' }
  ensureAxes(db, selfId)
  const cur = db.prepare('SELECT value FROM character_axes WHERE self_id=? AND axis=?').get(String(selfId), a)
  const d = Math.max(-Number(maxDelta), Math.min(Number(maxDelta), Number(delta) || 0))
  const v = Math.max(0, Math.min(1, Number(cur?.value ?? AXIS_DEFAULTS[a] ?? 0.5) + d))
  db.prepare('UPDATE character_axes SET value=?, updated_at=? WHERE self_id=? AND axis=?').run(v, Number(at), String(selfId), a)
  return { ok: true, axis: a, value: Number(v.toFixed(3)), delta: Number(d.toFixed(3)) }
}

export function axesText(db, selfId) {
  const rows = listAxes(db, selfId)
  if (!rows.length) return ''
  const bits = rows.map((r) => `${r.axis}${Math.round(r.value * 100)}`)
  return `【性格底色】${bits.join(' · ')}（短期事件不突变，别拿一天的事改性格）`
}
