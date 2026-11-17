/** 契约测试：dyPersona 全部方法的结构、错误码、权限矩阵（契约 v1.2 §2/§4/§5）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { E } from '../lib/db.js'
import { ensureState } from '../lib/emotion.js'
import { bootPlugin, makeAgent, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const OWNER = '/tmp/fixture-owner-private'
const CFG = { inject: { mode: 'full', sessionDirs: [{ dir: OWNER, mode: 'full' }] } }
const OWNER_HEADER = { id: 'sess-owner', cwd: OWNER }

async function boot(extra = {}) {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const p = await bootPlugin({ cfg: { dataDir: dir, personaPath, ...CFG, ...extra } })
  return { ...p, dir }
}

test('服务名与取值：ctx.get("dyPersona") 就是提供的对象', async () => {
  const { ctx, service } = await boot()
  assert.equal(ctx.get('dyPersona'), service)
  assert.equal(ctx.get('persona'), undefined, '旧服务名不应存在')
})

test('方法 1-6：selfId/displayName/personaText/voice/block/version 的结构', async () => {
  const { service } = await boot()
  assert.match(service.selfId(), /^self:[0-9a-f-]{36}$/)
  assert.equal(typeof service.displayName(), 'string')
  assert.ok(service.displayName().length > 0)

  const text = service.personaText()
  assert.equal(typeof text, 'string')
  assert.doesNotMatch(text, /\{\{display_name\}\}/, '必须已渲染')
  assert.match(text, /名字：汐/)

  const voice = service.voice()
  assert.equal(typeof voice, 'string')
  assert.ok(voice.length <= 120)

  const block = service.block()
  assert.deepEqual(Object.keys(block).sort(), ['mode', 'text'])
  assert.ok(['full', 'brief', 'off'].includes(block.mode))

  const version = service.version()
  assert.deepEqual(Object.keys(version).sort(), ['hash', 'nameVersion', 'personaVersion'])
  assert.equal(typeof version.hash, 'string')
  assert.equal(version.hash.length, 64, 'sha256 hex')
  assert.equal(typeof version.personaVersion, 'number')
  assert.equal(typeof version.nameVersion, 'number')
})

test('方法 7-9：emotion.state / toneHint / why 的结构', async () => {
  const { service } = await boot()
  const st = service.emotion.state()
  // P0-B：state 新增 energy/social（给 HUD 读）
  assert.deepEqual(Object.keys(st).sort(), ['arousal', 'certainty', 'dominance', 'energy', 'episode', 'intensity', 'label', 'moodArousal', 'moodValence', 'social', 'stateIntensity', 'stateLabel', 'updatedAt', 'valence'])
  assert.ok(st.valence >= -1 && st.valence <= 1)
  assert.ok(st.arousal >= 0 && st.arousal <= 1)
  assert.ok(st.certainty >= 0 && st.certainty <= 1)
  assert.ok(st.energy >= 0.2 && st.energy <= 1)
  assert.ok(st.social >= 0.1 && st.social <= 0.95)
  assert.ok(st.intensity >= 0 && st.intensity <= 1)
  assert.equal(typeof st.label, 'string')
  assert.equal(typeof st.updatedAt, 'number')

  const hint = service.emotion.toneHint()
  assert.equal(typeof hint, 'string')
  assert.ok(hint.length <= 40)
  assert.doesNotMatch(hint, /\d/)

  const why = service.emotion.why(6, { header: OWNER_HEADER })
  assert.deepEqual(Object.keys(why), ['points'])
  assert.ok(Array.isArray(why.points))
})

test('why 权限矩阵：无 header / 子智能体三种 / 群聊 / 白名单外 全部 E_PERMISSION', async () => {
  const { service } = await boot()
  const cases = [
    ['无参数', () => service.emotion.why(6)],
    ['空 opts', () => service.emotion.why(6, {})],
    ['parentSession', () => service.emotion.why(6, { header: { ...OWNER_HEADER, parentSession: 'p' } })],
    ['origin=subagent', () => service.emotion.why(6, { header: { ...OWNER_HEADER, origin: 'subagent' } })],
    ['delegationDepth', () => service.emotion.why(6, { header: { ...OWNER_HEADER, delegationDepth: 2 } })],
    ['群聊目录', () => service.emotion.why(6, { header: { id: 'g', cwd: '/tmp/群_000' } })],
    ['白名单外', () => service.emotion.why(6, { header: { id: 'o', cwd: '/tmp/elsewhere' } })],
  ]
  for (const [name, fn] of cases) {
    assert.throws(fn, (err) => err.code === E.PERMISSION, `${name} 应 E_PERMISSION`)
  }
  // opts.session.header 形式也认
  assert.doesNotThrow(() => service.emotion.why(6, { session: { header: OWNER_HEADER } }))
})

test('why 参数校验：hours 越界 → E_INVALID_ARG（不是 E_PERMISSION）', async () => {
  const { service } = await boot()
  for (const hours of [0, -1, Number.NaN, 721, 100000]) {
    assert.throws(
      () => service.emotion.why(hours, { header: OWNER_HEADER }),
      (err) => err.code === E.INVALID_ARG,
      `hours=${hours}`,
    )
  }
  assert.doesNotThrow(() => service.emotion.why(720, { header: OWNER_HEADER }))
})

test('why point 形状 + 空 ref → "none" + includeTrigger=false 省略 trigger', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const p = await bootPlugin({ cfg: { dataDir: dir, personaPath, ...CFG } })
  const dbPath = join(dir, 'persona.db')
  const selfId = p.service.selfId()
  const db = new DatabaseSync(dbPath)
  ensureState(db, selfId)
  const now = Date.now()
  db.prepare('INSERT INTO emotion_points(self_id,at,dimension,delta,value_after,trigger,msg_ref) VALUES(?,?,?,?,?,?,?)')
    .run(selfId, now, 'valence', -0.3, -0.1, '某句', 'explicit:s:1')
  db.prepare('INSERT INTO emotion_points(self_id,at,dimension,delta,value_after,trigger,msg_ref) VALUES(?,?,?,?,?,?,?)')
    .run(selfId, now - 10, 'arousal', 0.2, 0.5, '', '')
  db.close()

  const why = p.service.emotion.why(6, { header: OWNER_HEADER })
  assert.equal(why.points.length, 2)
  for (const pt of why.points) {
    for (const key of ['at', 'dimension', 'delta', 'valueAfter', 'msgRef']) assert.ok(key in pt, `缺 ${key}`)
    assert.ok(['valence', 'arousal'].includes(pt.dimension))
  }
  const emptyRef = why.points.find((x) => x.delta === 0.2)
  assert.equal(emptyRef.msgRef, 'none')
  assert.equal('trigger' in emptyRef, false, '空 trigger 不应出现')

  const noTrigger = p.service.emotion.why(6, { header: OWNER_HEADER, includeTrigger: false })
  assert.ok(noTrigger.points.every((x) => !('trigger' in x)))
})

test('降级：DB 关闭后所有方法不抛，state 带 degraded', async () => {
  const mod = await import('../lib/service.js')
  const broken = mod.createPersonaService({
    db: () => null,
    cfg: { personaPath: '/nonexistent/persona.md', inject: { mode: 'full' }, emotion: {} },
    self: () => null,
  })
  assert.equal(broken.selfId(), 'self:unknown')
  assert.equal(broken.displayName(), '')
  assert.equal(broken.personaText(), '')
  assert.equal(broken.voice(), '')
  assert.deepEqual(broken.block(), { mode: 'full', text: '' })
  assert.equal(broken.version().hash, '')
  const st = broken.emotion.state()
  assert.equal(st.degraded, true)
  assert.equal(st.label, '平静')
  assert.equal(broken.emotion.toneHint(), '')
})

test('工具层：返回 {ok,detail}，detail 为 JSON 字符串；子智能体不能改名/读 why', async () => {
  const { tools } = await boot()
  for (const def of tools.list()) {
    assert.equal(typeof def.name, 'string')
    assert.ok(def.parameters?.type === 'object', `${def.name} 缺 parameters`)
    assert.ok(def.output?.schema, `${def.name} 缺 output.schema`)
    assert.equal(typeof def.output.render, 'function')
  }
  const who = await tools.get('dy_persona_whoami').execute({}, {})
  assert.equal(typeof who.ok, 'boolean')
  assert.doesNotThrow(() => JSON.parse(who.detail))

  const subExec = { agent: makeAgent({ id: 'sub', cwd: OWNER, header: { parentSession: 'p' } }) }
  const rename = await tools.get('dy_persona_rename').execute({ name: '小汐' }, subExec)
  assert.equal(rename.ok, false)
  assert.match(rename.detail, /E_PERMISSION/)

  const why = await tools.get('dy_emotion_why').execute({ hours: 6 }, subExec)
  assert.equal(why.ok, false)
  assert.match(why.detail, /E_PERMISSION/)

  const whyNoExec = await tools.get('dy_emotion_why').execute({ hours: 6 }, {})
  assert.equal(whyNoExec.ok, false, '没有 header 也不给读')
})

test('emotion.state 的 updatedAt 随库中状态变化（不是常量）', async () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir)
  const p = await bootPlugin({ cfg: { dataDir: dir, personaPath, ...CFG } })
  const db = new DatabaseSync(join(dir, 'persona.db'))
  const selfId = p.service.selfId()
  ensureState(db, selfId)
  db.prepare('UPDATE emotion_state SET updated_at=? WHERE self_id=?').run(123456789, selfId)
  db.close()
  assert.equal(p.service.emotion.state().updatedAt, 123456789)
})
