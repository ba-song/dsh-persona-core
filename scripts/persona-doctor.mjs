#!/usr/bin/env node
/**
 * persona 体检（B5）：只读检查库完整性、self 身份、meta.self_id、persona.md 与版本哈希。
 * 用法：node scripts/persona-doctor.mjs [--data-dir ...]；exit 0=通过，1=有 FAIL。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const i = args.indexOf('--data-dir')
const dataDir = i >= 0 && args[i + 1] ? args[i + 1] : process.env.PERSONA_DATA_DIR || '/sdcard/DSHA/人格/数据'
const dbPath = join(dataDir, 'persona.db')
const mdPath = join(dataDir, 'persona.md')
const rows = []
const add = (level, key, detail) => rows.push({ level, key, detail })
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

if (!existsSync(dbPath)) add('FAIL', 'db', `库不存在：${dbPath}`)
else {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()
    add(integrity?.integrity_check === 'ok' ? 'PASS' : 'FAIL', 'integrity', integrity?.integrity_check ?? 'unknown')
    const self = db.prepare('SELECT id, display_name, persona_version FROM self LIMIT 1').get()
    if (!self) add('FAIL', 'self', 'self 表为空')
    else {
      add('PASS', 'self', `${self.display_name} (${self.id}) v${self.persona_version}`)
      const meta = db.prepare("SELECT value FROM meta WHERE key='self_id'").get()
      if (!meta) add('WARN', 'meta.self_id', '未固化（重启后会写入）')
      else add(meta.value === self.id ? 'PASS' : 'FAIL', 'meta.self_id', meta.value === self.id ? '与 self 一致' : `不一致：meta=${meta.value}`)
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM persona_versions').get()?.n ?? 0
    add(n > 0 ? 'PASS' : 'WARN', 'persona_versions', `${n} 个快照`)
  } catch (e) {
    add('FAIL', 'query', String(e?.message ?? e))
  } finally {
    db.close()
  }
}

if (!existsSync(mdPath)) add('FAIL', 'persona.md', `文件不存在：${mdPath}`)
else {
  const raw = readFileSync(mdPath, 'utf8')
  add(raw.trim() ? 'PASS' : 'FAIL', 'persona.md', `${statSync(mdPath).size} B，hash ${sha256(raw).slice(0, 12)}`)
}

const fails = rows.filter((r) => r.level === 'FAIL').length
console.log(JSON.stringify({ ok: fails === 0, dataDir, checks: rows, fails }, null, 2))
process.exit(fails === 0 ? 0 : 1)
