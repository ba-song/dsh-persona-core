/**
 * P1a：事件化 + 自述 + owner_act/冷落 + 工具失败。
 * 只测事件/评估/episode 与输出行；普通主人陈述不再镜像 valence。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bootPlugin, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const HOME = '/tmp/fixture-home'

async function boot() {
  const dir = tmpDir()
  const p = await bootPlugin({
    cfg: {
      dataDir: dir,
      personaPath: writeFixturePersona(dir),
      inject: { mode: 'full', sessionDirs: [HOME] },
      emotion: { ingestEnabled: true },
    },
  })
  return { p, dir }
}

function emitUser(p, text, seq, cwd = HOME, id = null) {
  p.ctx.emit('session/event', { header: { id: id ?? `s-${seq}`, cwd } }, {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
}

function emitSelf(p, text, seq, cwd = HOME) {
  p.ctx.emit('session/event', { header: { id: `s-${seq}`, cwd } }, {
    type: 'assistant/message',
    seq,
    time: Date.now(),
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  })
}

function emitTool(p, { isError, text = '{"ok":false}', seq = 1 }) {
  p.ctx.emit('session/event', { header: { id: 's-tool', cwd: HOME } }, {
    type: 'tool/result',
    seq,
    time: Date.now(),
    data: { message: { role: 'tool', isError, content: [{ type: 'text', text }] } },
  })
}

function rows(dir, sql, ...args) {
  const db = new DatabaseSync(join(dir, 'persona.db'), { readOnly: true })
  const out = db.prepare(sql).all(...args)
  db.close()
  return out
}

function one(dir, sql, ...args) {
  return rows(dir, sql, ...args)[0]
}

test('1) 她说「我有点累」→ self_report → fatigue episode（target=self）', async () => {
  const { p, dir } = await boot()
  emitSelf(p, '我有点累', 1)
  const ev = one(dir, 'select * from emotion_event where kind=? order by id desc limit 1', 'self_report')
  assert.ok(ev, '应有 self_report 事件')
  assert.equal(ev.subject, 'self')
  const ap = one(dir, 'select * from emotion_appraisal where event_id=?', ev.id)
  assert.equal(ap.rule_id, 'self_report_fatigue')
  const ep = one(dir, 'select * from emotion_episodes where appraisal_id=?', ap.id)
  assert.equal(ep.emotion, 'fatigue')
  assert.equal(ep.target, 'self')
  assert.match(p.service._emotionLineFor({ cwd: HOME }), /我有点累/)
})

test('2) 她说「他说我累」→ 转述不算，不产生事件/episode', async () => {
  const { p, dir } = await boot()
  emitSelf(p, '他说我累', 1)
  assert.equal(rows(dir, 'select * from emotion_event').length, 0)
  assert.equal(rows(dir, 'select * from emotion_episodes').length, 0)
})

test('3) 主人「谢谢你，乖」→ owner_act → joy/affection（target=owner）', async () => {
  const { p, dir } = await boot()
  emitUser(p, '谢谢你，乖', 1)
  const ev = one(dir, 'select * from emotion_event where kind=? order by id desc limit 1', 'owner_act')
  assert.ok(ev)
  const ap = one(dir, 'select * from emotion_appraisal where event_id=?', ev.id)
  assert.ok(['joy', 'affection'].includes(ap.emotion), `实际 ${ap.emotion}`)
  assert.equal(ap.target, 'owner')
  const ep = one(dir, 'select * from emotion_episodes where appraisal_id=?', ap.id)
  assert.equal(ep.target, 'owner')
  assert.match(p.service._emotionLineFor({ cwd: HOME }), /被夸得有点开心/)
})

test('4) 主人连续「嗯/哦/好」→ 只产生一次 worry/loneliness（target=owner）', async () => {
  const { p, dir } = await boot()
  for (const [i, t] of ['嗯', '哦', '好', '嗯'].entries()) emitUser(p, t, i + 1, HOME, 's-cold')
  const aps = rows(dir, "select * from emotion_appraisal where rule_id='owner_cold'")
  assert.equal(aps.length, 1, '连续短回复只发一次')
  assert.ok(['worry', 'loneliness'].includes(aps[0].emotion))
  assert.equal(aps[0].target, 'owner')
  assert.match(p.service._emotionLineFor({ cwd: HOME }), /有点想你/)
})

test('5) 工具失败 → frustration（target=tool，10–30min 半衰期）', async () => {
  const { p, dir } = await boot()
  emitTool(p, { isError: true, text: '{"ok":false,"error":"boom"}' })
  const ap = one(dir, "select * from emotion_appraisal where rule_id='tool_fail'")
  assert.ok(ap)
  assert.equal(ap.emotion, 'frustration')
  assert.equal(ap.target, 'tool')
  const ep = one(dir, 'select * from emotion_episodes where appraisal_id=?', ap.id)
  assert.equal(ep.target, 'tool')
  assert.ok(ep.half_life_s >= 600 && ep.half_life_s <= 1800, `半衰期 ${ep.half_life_s}`)
  assert.match(p.service._emotionLineFor({ cwd: HOME }), /工具又卡/)
})

test('6) 工具成功 → 不产生 episode', async () => {
  const { p, dir } = await boot()
  emitTool(p, { isError: false, text: '{"ok":true}' })
  assert.equal(rows(dir, 'select * from emotion_episodes').length, 0)
})

test('7) 主人「我累了」→ concern（不 fatigue；P0 回归）', async () => {
  const { p, dir } = await boot()
  emitUser(p, '我累了', 1)
  assert.equal(p.service.emotion.state().valence, 0)
  const ap = one(dir, "select * from emotion_appraisal where rule_id='owner_fatigue'")
  assert.ok(ap)
  assert.equal(ap.emotion, 'concern')
  const ep = one(dir, 'select * from emotion_episodes where appraisal_id=?', ap.id)
  assert.equal(ep.target, 'owner')
  assert.equal(ep.emotion, 'concern')
  assert.match(p.service._emotionLineFor({ cwd: HOME }), /担心/)
})

test('8) 主人普通陈述「今天天气不错」→ valence 不变、无 episode', async () => {
  const { p, dir } = await boot()
  emitUser(p, '今天天气不错', 1)
  assert.equal(p.service.emotion.state().valence, 0)
  assert.equal(rows(dir, 'select * from emotion_episodes').length, 0)
  assert.equal(rows(dir, 'select * from emotion_event').length, 0)
})
