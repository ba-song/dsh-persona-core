/**
 * B1：情绪否定误读 / trigger 时间前缀 / 注入上下文 interpolate:false。
 * 全部合成数据，不读不写生产库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import {
  DEFAULTS,
  ensureState,
  ingestEmotion,
  labelOf,
  scoreText,
  stripPromptPrefixes,
  timeline,
} from '../lib/emotion.js'
import { createInjector } from '../lib/inject.js'
import { loadConfig } from '../lib/config.js'
import {
  FIXTURE_PERSONA,
  makeAgent,
  tmpDir,
  writeFixturePersona,
} from './helpers/fixtures.mjs'

const OWNER = '/tmp/fixture-owner-private'

function freshDb() {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  return { db, self }
}

// ---------- 1. 否定 ----------

test('B1-否定正向词：变负（不再读成开心）', () => {
  const cases = ['我一点都不开心', '不开心', '我不好', '别开心了']
  for (const text of cases) {
    const s = scoreText(text)
    assert.ok(s.valence < -0.05, `${text} 应为负，实际 ${s.valence}`)
  }
  assert.equal(labelOf(scoreText('我一点都不开心').valence, scoreText('我一点都不开心').arousal), '低落')
  assert.equal(labelOf(scoreText('不开心').valence, scoreText('不开心').arousal), '低落')
})

test('B1-否定负向词：不再负，落轻微正/平静', () => {
  for (const text of ['没生气', '我不难过', '别难过', '不累']) {
    const s = scoreText(text)
    assert.ok(s.valence >= 0, `${text} 不应为负，实际 ${s.valence}`)
    assert.ok(s.valence <= 0.2, `${text} 应是轻微正，实际 ${s.valence}`)
    assert.equal(labelOf(s.valence, s.arousal), '平静', `${text} 标签应为平静`)
  }
})

test('B1-双重否定：回到原方向半强度', () => {
  const plain = scoreText('开心') // 0.40
  for (const text of ['不是不开心', '不能不开心']) {
    const s = scoreText(text)
    assert.ok(s.valence > 0.05, `${text} 应为正，实际 ${s.valence}`)
    assert.ok(s.valence < plain.valence, `${text} 应为半强度（<${plain.valence}），实际 ${s.valence}`)
  }
})

test('B1-程度词不吃否定：特别/一点都/有点 不改变否定方向', () => {
  assert.ok(scoreText('特别不开心').valence < 0)
  assert.ok(scoreText('一点都不开心').valence < 0)
  assert.ok(scoreText('有点不开心').valence < 0)
  assert.ok(scoreText('特别开心').valence > 0, '「特别」里的「别」不是否定')
  assert.ok(scoreText('无比开心').valence > 0, '「无比」里的「无」不是否定')
})

test('B1-复合词不误判：别人/忍不住/不错/非常', () => {
  assert.ok(scoreText('忍不住笑了').valence > 0, '「忍不住」不是否定')
  assert.ok(scoreText('不错').valence > 0, '「不错」是正向短语')
  assert.ok(scoreText('非常开心').valence > 0, '「非常」不是否定')
  assert.equal(scoreText('我去别人的房间').hits, 0, '「别人」不应制造情绪词')
})

test('B1-否定不跨小句', () => {
  const s = scoreText('我不去，开心')
  assert.ok(s.valence > 0, `逗号后的开心不应被前面的否定吃掉，实际 ${s.valence}`)
})

test('B1-反讽仍走现有逻辑：降置信、不改符号', () => {
  const plain = scoreText('真棒')
  const irony = scoreText('呵呵，真棒')
  assert.equal(irony.irony, true)
  assert.equal(irony.hits, plain.hits)
  assert.ok(irony.confidence < plain.confidence, '反讽必须降置信')
  assert.ok(irony.valence > 0, '现有逻辑只降置信、不翻符号')
})

test('B1-无情绪词：hits=0、中性', () => {
  const s = scoreText('今天出门走了走')
  assert.equal(s.hits, 0)
  assert.equal(s.valence, 0)
  assert.equal(s.confidence, 0.2)
})

test('B1-英文与符号干扰：不误命中、不抛', () => {
  for (const text of ['not happy at all 😅!!!', 'happy???', '!!!...???']) {
    const s = scoreText(text)
    assert.equal(s.hits, 0, `${text} 不应命中中文词表`)
    assert.equal(s.valence, 0)
  }
})

test('B1-疲惫提示：不累/不困不算疲惫，没力气/撑不住仍算', () => {
  assert.equal(scoreText('不累').hint, null)
  assert.equal(scoreText('不困').hint, null)
  assert.equal(scoreText('有点累').hint, '疲惫')
  assert.equal(scoreText('没力气').hint, '疲惫')
  assert.equal(scoreText('撑不住').hint, '疲惫')
})

// ---------- 2. trigger 时间前缀 ----------

test('B1-trigger 剥掉时间前缀与说话人标签，存用户原话', () => {
  const { db, self } = freshDb()
  const at = Date.now()
  const prefixed = '[现在是 2026-11-02 周一 01:25（凌晨）] [饲养员] 太晚了，有点烦'
  ingestEmotion(db, self.id, { text: prefixed, trigger: prefixed, msgRef: 'explicit:b1:1', at, opts: DEFAULTS, forceAudit: true })
  const row = timeline(db, self.id, 24).at(-1)
  assert.equal(row.trigger, '太晚了，有点烦')
  assert.equal(row.trigger.includes('现在是'), false)
  assert.equal(row.trigger.includes('饲养员'), false)
  db.close()
})

test('B1-trigger 无时间前缀时保留正文方括号', () => {
  const { db, self } = freshDb()
  const at = Date.now()
  ingestEmotion(db, self.id, { text: '[图片] 有点烦', trigger: '[图片] 有点烦', msgRef: 'explicit:b1:2', at, opts: DEFAULTS, forceAudit: true })
  const row = timeline(db, self.id, 24).at(-1)
  assert.ok(row, '应写入时间线')
  assert.equal(row.trigger, '[图片] 有点烦')
  db.close()
})

test('B1-trigger 截断发生在剥前缀之后', () => {
  const { db, self } = freshDb()
  const at = Date.now()
  const prefixed = '[现在是 2026-11-02 周一 01:25（凌晨）] [饲养员] 有点烦，真的有点烦，还有点难过'
  ingestEmotion(db, self.id, {
    text: prefixed,
    trigger: prefixed,
    msgRef: 'explicit:b1:3',
    at,
    opts: { ...DEFAULTS, triggerMaxChars: 10 },
    forceAudit: true,
  })
  const row = timeline(db, self.id, 24).at(-1)
  assert.ok(row.trigger.length <= 10, `长度 ${row.trigger.length}`)
  assert.equal(row.trigger.startsWith('有点烦'), true, `实际 ${row.trigger}`)
  assert.equal(row.trigger.includes('现在是'), false)
  db.close()
})

test('B1-打分不吃时间前缀里的昵称（开心果不带偏正文）', () => {
  const { db, self } = freshDb()
  const at = Date.now()
  const prefixed = '[现在是 2026-11-02 周一 01:51（凌晨）] [开心果] 今天一般'
  ingestEmotion(db, self.id, { text: prefixed, trigger: prefixed, msgRef: 'explicit:b1:4', at, opts: DEFAULTS, forceAudit: true })
  const row = timeline(db, self.id, 24).at(-1)
  assert.equal(row.trigger, '今天一般')
  assert.ok(Math.abs(row.valence) < 0.01, `前缀昵称不应带偏，valence=${row.valence}`)
  db.close()
})

test('B1-stripPromptPrefixes 纯函数：多段前缀 / 普通方括号', () => {
  assert.equal(
    stripPromptPrefixes('[现在是 2026-11-02 周一 01:25（凌晨）] [当前时间 01:25] [张三 (123456789) · 饲养员 20:31] 你好'),
    '你好',
  )
  assert.equal(stripPromptPrefixes('[图片] 看这个'), '[图片] 看这个')
  assert.equal(stripPromptPrefixes('  普通  文本 '), '普通 文本')
})

// ---------- 3. interpolate:false ----------

test('B1-两个注入 context 都显式 interpolate:false，且人格文本字面量保留 {{foo}}', () => {
  const dir = tmpDir()
  const personaPath = writeFixturePersona(dir, `${FIXTURE_PERSONA}\n暗号：{{foo}}\n`)
  const cfg = loadConfig({
    dataDir: dir,
    personaPath,
    inject: { mode: 'full', sessionDirs: [{ dir: OWNER, mode: 'full' }] },
  })
  const injector = createInjector({
    cfg,
    log: console,
    state: { self: { display_name: '汐' }, emotionLine: () => '【你现在的情绪】平静；这轮说话和平时差不多。{{hint}}' },
  })
  const agent = makeAgent({ id: 'b1-inject', cwd: OWNER })
  const r = injector.mount(agent)
  assert.equal(r.mounted, true)

  const persona = agent._registered.find((x) => x.name === 'dy-persona')
  const emotion = agent._registered.find((x) => x.name === 'dy-emotion')
  assert.ok(persona, '应挂 dy-persona')
  assert.ok(emotion, '应挂 dy-emotion')
  assert.equal(persona.interpolate, false)
  assert.equal(emotion.interpolate, false)
  assert.equal(persona.required, undefined, 'required 不应设置')
  assert.equal(emotion.required, undefined, 'required 不应设置')

  const ptext = persona.text()
  assert.ok(ptext.includes('暗号：{{foo}}'), '未注册占位符必须原样保留')
  assert.ok(ptext.includes('名字：汐'), '已注册的 display_name 应正常渲染')
  assert.equal(ptext.includes('{{display_name}}'), false)

  const etext = emotion.text()
  assert.equal(etext, '【你现在的情绪】平静；这轮说话和平时差不多。{{hint}}')
  assert.equal(etext.includes('{{hint}}'), true, '情绪行也必须是字面量')
})

test('B1-全库四处 systemPrompt.context（persona/emotion/voice/style，防止漏挂）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const { join: pjoin } = await import('node:path')
  const root = new URL('../lib/', import.meta.url).pathname
  let count = 0
  for (const f of readdirSync(root).filter((n) => n.endsWith('.js'))) {
    const text = readFileSync(pjoin(root, f), 'utf8')
    count += (text.match(/systemPrompt\.context\(/g) ?? []).length
  }
  assert.equal(count, 8, `persona 侧应有 8 处 context（persona/emotion/voice/emotion-act/style/grievance/world/axes），实际 ${count}`)
})

test('B1-她照顾主人说“你困了”不把自己标成疲惫', () => {
  const { db, self } = freshDb()
  ingestEmotion(db, self.id, { text: '嗯，去了。你昨晚睡得晚，困了补一觉。', trigger: '你困了补一觉', self: true, at: Date.now(), opts: DEFAULTS, forceAudit: true })
  const row = db.prepare('SELECT label FROM emotion_state WHERE self_id=?').get(self.id)
  assert.notEqual(row.label, '疲惫')
})
