/**
 * P0-A：主人疲惫 → concern episode（target=owner），不改她的 valence/fatigue。
 * P0-B：energy/social 最小 homeostasis。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import {
  DEFAULTS,
  activeConcern,
  applyHomeostasis,
  ensureState,
  homeostasisAt,
  ingestEmotion,
  timeline,
} from '../lib/emotion.js'
import { loadConfig } from '../lib/config.js'
import { createPersonaService } from '../lib/service.js'
import { bootPlugin, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const HOME = '/tmp/fixture-home'

function freshDb() {
  const dir = tmpDir()
  const db = openDb(join(dir, 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  return { db, self, dir }
}

function ingest(db, self, text, { self: isSelf = false, at = Date.now(), opts = {} } = {}) {
  return ingestEmotion(db, self.id, {
    text,
    msgRef: `explicit:p0:${Math.random().toString(16).slice(2)}`,
    at,
    opts: { ...DEFAULTS, ...opts },
    self: isSelf,
    forceAudit: true,
  })
}

test('主人「我累了」：生成 concern，不改 valence、不写时间线', () => {
  const { db, self, dir } = freshDb()
  const at = Date.now()
  const out = ingest(db, self, '我累了', { at })
  assert.equal(out.applied, false)
  const row = db.prepare('select valence,label,energy,social from emotion_state where self_id=?').get(self.id)
  assert.equal(row.valence, 0)
  assert.equal(row.label, '平静')
  assert.equal(timeline(db, self.id, 24).length, 0, '不应写疲惫时间线')
  const episodes = db.prepare("select * from emotion_episodes where self_id=? and target='owner'").all(self.id)
  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].emotion, 'concern')
  assert.equal(episodes[0].cause, '主人累了')
  assert.ok(episodes[0].intensity >= 0.35 && episodes[0].intensity <= 0.6, `强度 ${episodes[0].intensity}`)
  assert.equal(episodes[0].half_life_s, 7200)
  assert.ok(activeConcern(db, self.id, at).intensity >= 0.34)

  const cfg = loadConfig({ dataDir: dir, inject: { mode: 'full', sessionDirs: [HOME] } })
  const svc = createPersonaService({ db: () => db, cfg, self: () => self })
  const line = svc._emotionLineFor({ cwd: HOME })
  assert.match(line, /担心/, `输出行应含担心，实际 ${line}`)
  db.close()
})

test('主人「你困了嘛」：问句也生成 concern，仍不改 valence', () => {
  const { db, self, dir } = freshDb()
  const at = Date.now()
  ingest(db, self, '你困了嘛', { at })
  assert.equal(db.prepare('select valence from emotion_state where self_id=?').get(self.id).valence, 0)
  const eps = db.prepare("select * from emotion_episodes where self_id=? and target='owner'").all(self.id)
  assert.equal(eps.length, 1)
  const cfg = loadConfig({ dataDir: dir, inject: { mode: 'full', sessionDirs: [HOME] } })
  const svc = createPersonaService({ db: () => db, cfg, self: () => self })
  assert.match(svc._emotionLineFor({ cwd: HOME }), /担心/)
  db.close()
})

test('主人「我不累」：不生成 concern；她「我有点累」仍可 fatigue（self）', () => {
  const a = freshDb()
  ingest(a.db, a.self, '我不累')
  assert.equal(a.db.prepare("select count(*) c from emotion_episodes where self_id=? and target='owner'").get(a.self.id).c, 0)
  a.db.close()

  const b = freshDb()
  const out = ingest(b.db, b.self, '我有点累', { self: true })
  assert.equal(out.applied, true)
  assert.equal(b.db.prepare("select count(*) c from emotion_episodes where self_id=?").get(b.self.id).c, 0)
  const row = b.db.prepare('select label,valence from emotion_state where self_id=?').get(b.self.id)
  assert.equal(row.label, '疲惫')
  assert.ok(row.valence < 0, `self 疲惫应负向，实际 ${row.valence}`)
  b.db.close()
})

test('homeostasis：夜间 energy 恢复更快，social 每小时 -0.01，clamp', () => {
  const base = Date.UTC(2026, 10, 6, 16, 0) // 北京时间 00:00
  const night = homeostasisAt({ energy: 0.5, social: 0.5, ess_updated_at: base }, base + 2 * 3600_000)
  assert.equal(night.energy.toFixed(2), '0.60')
  assert.equal(night.social.toFixed(2), '0.48')

  const dayBase = Date.UTC(2026, 10, 6, 4, 0) // 北京时间 12:00
  const day = homeostasisAt({ energy: 0.5, social: 0.5, ess_updated_at: dayBase }, dayBase + 2 * 3600_000)
  assert.equal(day.energy.toFixed(2), '0.53')
  assert.equal(day.social.toFixed(2), '0.48')

  const cap = homeostasisAt({ energy: 0.99, social: 0.1, ess_updated_at: dayBase }, dayBase + 100 * 3600_000)
  assert.equal(cap.energy, 1)
  assert.equal(cap.social, 0.1)
})

test('每次交互 energy -0.005；正向 social +0.02；无正向不加；floor 0.2/cap 0.95', () => {
  const { db, self } = freshDb()
  const at = Date.now()
  const pos = ingest(db, self, '今天很开心')
  const row1 = db.prepare('select energy,social from emotion_state where self_id=?').get(self.id)
  assert.equal(row1.energy.toFixed(3), '0.695')
  assert.equal(row1.social.toFixed(2), '0.72')

  const noHit = ingest(db, self, '今天出门走了走')
  assert.equal(noHit.applied, false)
  const row2 = db.prepare('select energy,social from emotion_state where self_id=?').get(self.id)
  assert.equal(row2.energy.toFixed(3), '0.690')
  assert.equal(row2.social.toFixed(2), '0.72', '无正向互动 socialism 不加')

  db.prepare('update emotion_state set energy=0.1, social=1 where self_id=?').run(self.id)
  const clamp = applyHomeostasis(db, self.id, at + 1000, { positive: true })
  assert.equal(clamp.energy, 0.2)
  assert.equal(clamp.social, 0.95)
  db.close()
})

test('服务 state 暴露 energy/social（给 HUD）', async () => {
  const dir = tmpDir()
  const p = await bootPlugin({ cfg: { dataDir: dir, personaPath: writeFixturePersona(dir) } })
  const st = p.service.emotion.state()
  assert.ok(st.energy >= 0.2 && st.energy <= 1)
  assert.ok(st.social >= 0.1 && st.social <= 0.95)
})

test('插件链路：主人「我累了」→ 无疲惫时间线、有 concern、情绪行含担心', async () => {
  const dir = tmpDir()
  const p = await bootPlugin({
    cfg: {
      dataDir: dir,
      personaPath: writeFixturePersona(dir),
      inject: { mode: 'full', sessionDirs: [HOME] },
      emotion: { ingestEnabled: true },
    },
  })
  p.ctx.emit('session/event', { header: { id: 'p0-owner', cwd: HOME } }, {
    type: 'user/message',
    seq: 1,
    time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我累了' }] },
  })
  const st = p.service.emotion.state()
  assert.equal(st.valence, 0)
  assert.ok(st.energy < 0.7, `交互后 energy 应下降，实际 ${st.energy}`)
  assert.match(p.service._emotionLineFor({ cwd: HOME }), /担心/)
})
