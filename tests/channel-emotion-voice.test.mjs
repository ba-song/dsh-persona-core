/**
 * 渠道情绪行（QQ 房间也得有情绪）+ dy-voice 独立表达 + 渠道 refreshSelf。
 * 全部临时库，不读不写生产库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bootPlugin, makeAgent, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'
import { VOICE_HINT, ORDER_PERSONA, ORDER_EMOTION, ORDER_VOICE, CONTEXT_VOICE } from '../lib/inject.js'

const HOME = '/tmp/fixture-home'
const CHANNEL = '/sdcard/DSHA/渠道/qq/私聊_10001'
const GROUP = '/tmp/fixture-qq/群_123'

function mount(p, { id, cwd }) {
  const agent = makeAgent({ id, cwd })
  p.ctx.emit('agent/created', { agent })
  return agent
}

function ctxOf(agent, name) {
  return agent._registered.find((r) => r.name === name)
}

function setEmotion(dir, selfId, { valence = 0, arousal = 0.2, label = '平静' } = {}) {
  const db = new DatabaseSync(join(dir, 'persona.db'))
  db.prepare('UPDATE emotion_state SET valence=?, arousal=?, label=?, intensity=?, confidence=0.63, source=?, updated_at=? WHERE self_id=?')
    .run(valence, arousal, label, Math.max(Math.abs(valence), arousal), 'rule', Date.now(), selfId)
  db.close()
}

async function boot({ inject = {}, emotion = {} } = {}) {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const p = await bootPlugin({
    cfg: {
      dataDir: dir,
      personaPath,
      inject: { mode: 'full', sessionDirs: [HOME, CHANNEL], ...inject },
      emotion: { ingestEnabled: false, ...emotion },
    },
  })
  return { p, dir }
}

test('渠道私聊：强度低于阈值也注入粗粒度情绪行（不再整块消失）', async () => {
  const { p, dir } = await boot()
  setEmotion(dir, p.service.selfId(), { valence: 0, arousal: 0.2 })
  const agent = mount(p, { id: 'c-low', cwd: CHANNEL })
  const emo = ctxOf(agent, 'dy-emotion')
  assert.ok(emo, '应挂 dy-emotion')
  assert.equal(emo.text(), '【你现在的情绪】平静')
  assert.ok(ctxOf(agent, 'dy-persona'), '人格块也在')
})

test('渠道私聊：强度够时给完整情绪行（含语气）', async () => {
  const { p, dir } = await boot()
  setEmotion(dir, p.service.selfId(), { valence: -0.7, arousal: 0.9, label: '生气' })
  const agent = mount(p, { id: 'c-high', cwd: CHANNEL })
  const text = ctxOf(agent, 'dy-emotion').text()
  assert.match(text, /^【你现在的情绪】生气；这轮说话/)
})

test('群聊：只给粗粒度（标签，不含语气/原因/数值）', async () => {
  const { p, dir } = await boot({ inject: { groupMode: 'brief' } })
  setEmotion(dir, p.service.selfId(), { valence: -0.7, arousal: 0.9, label: '生气' })
  const agent = mount(p, { id: 'g-coarse', cwd: GROUP })
  const emo = ctxOf(agent, 'dy-emotion')
  assert.ok(emo)
  assert.equal(emo.text(), '【你现在的情绪】生气')
  assert.equal(emo.text().includes('这轮说话'), false)
  assert.equal(emo.text().includes('生气；'), false)
})

test('home 不回归：低强度仍为空，高强度才出完整行', async () => {
  const { p, dir } = await boot()
  setEmotion(dir, p.service.selfId(), { valence: 0, arousal: 0.2 })
  const agent = mount(p, { id: 'h-1', cwd: HOME })
  assert.equal(ctxOf(agent, 'dy-emotion').text(), '', 'home 低强度保持为空')
  setEmotion(dir, p.service.selfId(), { valence: 0.5, arousal: 0.8, label: '兴奋' })
  assert.match(ctxOf(agent, 'dy-emotion').text(), /^【你现在的情绪】兴奋；这轮说话/)
})

test('dy-voice：默认在 home/渠道都注入，≤80 字、order=920、interpolate:false', async () => {
  const { p } = await boot()
  assert.ok(VOICE_HINT.length <= 80, `voice 长度 ${VOICE_HINT.length}`)
  const home = mount(p, { id: 'v-home', cwd: HOME })
  const channel = mount(p, { id: 'v-channel', cwd: CHANNEL })
  for (const agent of [home, channel]) {
    const voice = ctxOf(agent, CONTEXT_VOICE)
    assert.ok(voice, '应挂 dy-voice')
    assert.equal(voice.order, ORDER_VOICE)
    assert.equal(voice.interpolate, false)
    assert.equal(voice.text(), VOICE_HINT)
  }
  assert.equal(ctxOf(home, 'dy-persona').order, ORDER_PERSONA)
  assert.equal(ctxOf(home, 'dy-emotion').order, ORDER_EMOTION)
})

test('dy-voice：inject.voiceHint=false 时关闭（只剩 persona/emotion）', async () => {
  const { p } = await boot({ inject: { voiceHint: false } })
  const agent = mount(p, { id: 'v-off', cwd: HOME })
  assert.equal(ctxOf(agent, CONTEXT_VOICE), undefined)
  // 2026-11-16：dy-relationship 恒定挂（不受 voiceHint 影响）
  assert.deepEqual(agent._registered.map((r) => r.name).sort(), ['dy-emotion', 'dy-emotion-act', 'dy-persona', 'dy-relationship'])
})

test('refreshSelf 在渠道会话生效：改名后新旧渠道会话都用新名', async () => {
  const { p, dir } = await boot()
  const old = mount(p, { id: 'r-old', cwd: CHANNEL })
  assert.match(ctxOf(old, 'dy-persona').text(), /名字：汐/)
  const db = new DatabaseSync(join(dir, 'persona.db'))
  db.prepare("UPDATE self SET display_name='杨汐', name_version=1, updated_at=? WHERE id=?").run(Date.now(), p.service.selfId())
  db.close()
  const fresh = mount(p, { id: 'r-new', cwd: CHANNEL })
  assert.match(ctxOf(fresh, 'dy-persona').text(), /名字：杨汐/, '新渠道会话用新名')
  assert.match(ctxOf(old, 'dy-persona').text(), /名字：杨汐/, '旧渠道会话下次组装也用新名')
})

test('渠道私聊的 owner_act 正常更新情绪（群聊不更新，边界）', async () => {
  const { p } = await boot({ emotion: { ingestEnabled: true } })
  const msg = (text, seq) => ({ type: 'user/message', seq, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const session = { header: { id: 'c-ingest', cwd: CHANNEL } }
  p.ctx.emit('session/event', session, msg('谢谢你，真棒！', 1))
  const afterPrivate = p.service.emotion.state()
  assert.ok(afterPrivate.valence > 0.05, `渠道私聊 owner_act 应更新情绪，实际 ${afterPrivate.valence}`)

  // 群聊：当前 ingest 仍只认 private，不更新（避免把群友的话算成主人的细节）
  const before = p.service.emotion.state()
  p.ctx.emit('session/event', { header: { id: 'g-ingest', cwd: GROUP } }, { type: 'user/message', seq: 2, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: '气死我了' }] } })
  const afterGroup = p.service.emotion.state()
  assert.ok(Math.abs(afterGroup.valence - before.valence) < 1e-6, '群聊不该更新全局情绪')
})
