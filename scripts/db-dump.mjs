#!/usr/bin/env node
/**
 * 迁移验证用：把库的「逻辑结构 + 数据」导成可比较的 JSON。
 * 只读打开，不写库。
 */
import { DatabaseSync } from 'node:sqlite'

const path = process.argv[2]
const db = new DatabaseSync(path, { readOnly: true })

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name)

const indexes = db
  .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()

const out = { path, tables: {}, indexes, meta: {} }
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  const rows = db.prepare(`SELECT * FROM ${t}`).all()
  out.tables[t] = { columns: cols, rowCount: rows.length, rows }
  if (t === 'meta') for (const r of rows) out.meta[r.key] = r.value
}
console.log(JSON.stringify(out, null, 2))
db.close()
