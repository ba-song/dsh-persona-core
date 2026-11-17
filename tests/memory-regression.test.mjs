/**
 * F15 记忆插件回归（只读副本）：
 * 改名 / 注入 / 情绪读取之后，memory.db 的 raw 行数、id 序列、role 分布必须一字不变。
 * 不打开生产库；只读临时副本，且只做聚合统计（不读正文）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bootPlugin, makeAgent, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

// 2026-11-04 迁移后的线上 memory.db（旧 /opt/qqai 已不存在）
const MEMORY_DB = '/sdcard/DSHA/记忆/数据/memory.db'
const OWNER = '/tmp/fixture-owner-private'
const RUNS = 50

function haveMemoryDb() {
  try {
    return existsSync(MEMORY_DB) && readFileSync(MEMORY_DB, { length: 1 }).length > 0
  } catch {
    return false
  }
}

/** 只做聚合：行数、id 区间、role 分布、sqlite_sequence、文件 hash。 */
function snapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const out = {}
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  out.rawMeta = {
    count: one('SELECT COUNT(*) c FROM raw_meta').c,
    minId: one('SELECT MIN(id) v FROM raw_meta').v,
    maxId: one('SELECT MAX(id) v FROM raw_meta').v,
    sumChars: one('SELECT COALESCE(SUM(chars),0) v FROM raw_meta').v,
  }
  out.roles = Object.fromEntries(
    db
      .prepare('SELECT role, COUNT(*) c FROM raw_meta GROUP BY role ORDER BY role')
      .all()
      .map((r) => [String(r.role), r.c]),
  )
  out.channels = Object.fromEntries(
    db
      .prepare("SELECT COALESCE(channel,'(none)') k, COUNT(*) c FROM raw_meta GROUP BY k ORDER BY k")
      .all()
      .map((r) => [String(r.k), r.c]),
  )
  out.rawFts = one('SELECT COUNT(*) c FROM raw_fts').c
  out.memories = one('SELECT COUNT(*) c FROM memories').c
  try {
    out.seq = one("SELECT seq FROM sqlite_sequence WHERE name='raw_meta'")?.seq ?? null
  } catch {
    out.seq = null
  }
  out.emotion = Object.fromEntries(
    ['emotion_state', 'emotion_timeline', 'emotion_points', 'emotion_audit'].map((t) => [t, one(`SELECT COUNT(*) c FROM ${t}`).c]),
  )
  db.close()
  out.sha256 = createHash('sha256').update(readFileSync(dbPath)).digest('hex')
  return out
}

test('F15 前置：memory.db 存在（只读副本，不碰生产）', { skip: !haveMemoryDb() && 'memory.db 不存在，跳过' }, () => {
  const dir = tmpDir()
  const copy = join(dir, 'memory-copy.db')
  copyFileSync(MEMORY_DB, copy)
  const before = snapshot(copy)
  assert.ok(before.rawMeta.count > 0, '副本应有 raw 行')
  assert.equal(before.rawMeta.minId !== null, true)
})

test(
  'F15：改名/注入/情绪读取后 memory 副本逐项不变',
  { skip: !haveMemoryDb() && 'memory.db 不存在，跳过' },
  async () => {
    const dir = tmpDir()
    const memoryCopy = join(dir, 'memory-copy.db')
    copyFileSync(MEMORY_DB, memoryCopy)
    const before = snapshot(memoryCopy)

    // persona 侧：独立临时库，做改名 / 注入 / 连续求值 / 溯源
    const personaPath = writeFixturePersona(dir)
    const p = await bootPlugin({
      cfg: {
        dataDir: dir,
        dbPath: join(dir, 'persona.db'),
        personaPath,
        inject: { mode: 'full', sessionDirs: [{ dir: OWNER, mode: 'full' }] },
      },
    })
    const selfBefore = p.service.selfId()
    const agent = makeAgent({ id: 'f15', cwd: OWNER })
    p.ctx.emit('agent/created', { agent })
    const personaCtx = agent._registered.find((r) => r.name === 'dy-persona')
    const emoCtx = agent._registered.find((r) => r.name === 'dy-emotion')

    for (let i = 0; i < RUNS; i++) {
      personaCtx.text()
      emoCtx.text()
      p.service.emotion.state()
      p.service.block()
    }
    const renameTool = p.tools.get('dy_persona_rename')
    for (const name of ['小汐', '汐', '小汐']) {
      const r = await renameTool.execute({ name, reason: 'F15 回归' }, { agent })
      assert.equal(r.ok, true)
    }
    p.service.emotion.why(6, { header: { id: 'f15', cwd: OWNER } })

    const selfAfter = p.service.selfId()
    assert.equal(selfAfter, selfBefore, '改名后 self_id 不变')
    assert.equal(p.service.displayName(), '小汐')

    const after = snapshot(memoryCopy)
    assert.deepEqual(after, before, `memory 副本被改动：${JSON.stringify({ before, after })}`)
  },
)

test('F15：persona 代码不依赖 memory 库/表（静态检查）', () => {
  const dir = new URL('../lib/', import.meta.url).pathname
  const files = ['index.js', 'service.js', 'self.js', 'persona.js', 'emotion.js', 'scope.js', 'inject.js', 'tools.js', 'db.js', 'preflight.js', 'emo-observe.js']
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8')
    assert.doesNotMatch(text, /memory\.db/, `${f} 不应引用 memory.db`)
    assert.doesNotMatch(text, /raw_meta|raw_fts|memories\b/, `${f} 不应读记忆表`)
  }
})

test('F15：persona 库操作不会创建/修改 memory 路径下的文件', { skip: !haveMemoryDb() && 'memory.db 不存在，跳过' }, async () => {
  const dir = tmpDir()
  const memoryCopy = join(dir, 'memory-copy.db')
  copyFileSync(MEMORY_DB, memoryCopy)
  const hashBefore = createHash('sha256').update(readFileSync(memoryCopy)).digest('hex')

  const personaPath = writeFixturePersona(dir)
  const p = await bootPlugin({
    cfg: { dataDir: dir, dbPath: join(dir, 'persona.db'), personaPath, inject: { mode: 'brief', sessionDirs: [OWNER] } },
  })
  const agent = makeAgent({ id: 'f15-2', cwd: OWNER })
  p.ctx.emit('agent/created', { agent })
  agent._registered.forEach((r) => r.text())
  await p.tools.get('dy_persona_rename').execute({ name: '另一个名字' }, { agent })

  const hashAfter = createHash('sha256').update(readFileSync(memoryCopy)).digest('hex')
  assert.equal(hashAfter, hashBefore, 'memory 副本不得被 persona 侧改动')
  // persona 只应创建自己的库文件
  const files = (await import('node:fs')).readdirSync(dir).filter((f) => f.startsWith('persona.db'))
  assert.ok(files.length >= 1, `应有 persona.db：${files.join(',')}`)
})
