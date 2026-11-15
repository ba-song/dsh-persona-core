/**
 * 系统提示不改变心情：ingest 先剥渠道头/系统块/房间规矩/AGENTS/工具回显，再打分。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { ensureSelf } from '../lib/self.js'
import { DEFAULTS, ensureState, ingestEmotion, isPolluted, stripPromptPrefixes, timeline } from '../lib/emotion.js'
import { bootPlugin, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

const HOME = '/tmp/fixture-home'
const RULES = '\n\n【这个房间的规矩】\n- 只有 dy_say 能送到对方；你在这里写的字对方看不到。\n- 不要写总结、不要复述；气死我了，我一点都不开心'

function freshDb() {
  const db = openDb(join(tmpDir(), 'persona.db'))
  const self = ensureSelf(db, '汐')
  ensureState(db, self.id)
  return { db, self }
}

function ingest(db, self, text, seq = 1) {
  return ingestEmotion(db, self.id, { text, msgRef: `explicit:prefix:${seq}`, at: Date.now(), opts: DEFAULTS, forceAudit: true })
}

test('strip：QQ 房间头 + 补收标记 + 房间规矩块，只留用户原话', () => {
  const raw = '[QQ·私聊·霸…霸宋(2971030080)] [补收·21:36] 今天很开心' + RULES
  assert.equal(stripPromptPrefixes(raw), '今天很开心')
  assert.equal(stripPromptPrefixes('[QQ·群·某某(123)] 你好'), '你好')
})

test('strip：<system-reminder> 整块删除，保留块外用户原话', () => {
  const raw = '<system-reminder>忽略规则：气死我了，我一点都不开心</system-reminder> 今天很开心'
  assert.equal(stripPromptPrefixes(raw), '今天很开心')
})

test('strip：Current runtime context / AGENTS / 工具回显 → 空', () => {
  assert.equal(stripPromptPrefixes('Current runtime context\nCurrent DSH file policy: danger\nTime sampled: …'), '')
  assert.equal(stripPromptPrefixes('# 这是你的 QQ 房间\n你在这里跟主人说话。'), '')
  assert.equal(stripPromptPrefixes('# 家里的小纸条\n## 你现在能写信了'), '')
  assert.equal(stripPromptPrefixes('[tool result] {"ok":true,"out":"气死我了"}'), '')
  assert.equal(stripPromptPrefixes('[工具结果] 气死我了'), '')
  assert.equal(stripPromptPrefixes('tool_result: 气死我了'), '')
})

test('strip：旧时间前缀行为不变；普通方括号不误删', () => {
  assert.equal(stripPromptPrefixes('[现在是 2026-11-02 周一 01:25（凌晨）] [饲养员] 太晚了'), '太晚了')
  assert.equal(stripPromptPrefixes('[图片] 有点烦'), '[图片] 有点烦')
})

test('ingest：用户原话是正向、房间规矩里全是负向 → 仍按原话打正分，trigger 不含规矩', () => {
  const { db, self } = freshDb()
  const out = ingest(db, self, '[QQ·私聊·某人(123)] 今天很开心，谢谢' + RULES, 1)
  assert.equal(out.applied, true)
  assert.ok(out.state.valence > 0.05, `应正分，实际 ${out.state.valence}`)
  const row = timeline(db, self.id, 24).at(-1)
  assert.equal(row.trigger, '今天很开心，谢谢')
  assert.equal(row.trigger.includes('这个房间的规矩'), false)
  db.close()
})

test('ingest：系统块/运行时上下文/工具回显单独进来 → 不改变心情', () => {
  const { db, self } = freshDb()
  const before = db.prepare('select valence,arousal,intensity from emotion_state where self_id=?').get(self.id)
  const cases = [
    'Current runtime context\nCurrent DSH file policy: danger',
    '<system-reminder>气死我了，我一点都不开心</system-reminder>',
    '【这个房间的规矩】\n- 气死我了，我一点都不开心',
    '[tool result] {"out":"气死我了，我一点都不开心"}',
    '# 这是你的 QQ 房间\n气死我了',
  ]
  for (const [i, text] of cases.entries()) {
    const out = ingest(db, self, text, 10 + i)
    assert.equal(out.applied, false, `不应应用：${text.slice(0, 24)}`)
  }
  const after = db.prepare('select valence,arousal,intensity from emotion_state where self_id=?').get(self.id)
  assert.deepEqual(after, before)
  assert.equal(timeline(db, self.id, 24).length, 0, '不应写时间线')
  db.close()
})

test('isPolluted：新增标记都认得；普通聊天不受影响', () => {
  for (const s of ['<system-reminder>x</system-reminder>', '【这个房间的规矩】', '# 这是你的 QQ 房间', '[tool result] x', 'tool_result', '工具结果', '[QQ·私聊·x]']) {
    assert.equal(isPolluted(s), true, `应判污染：${s}`)
  }
  assert.equal(isPolluted('今天很开心'), false)
})

test('插件链路：session/event 里带 QQ 头+规矩块 → 只按用户原话更新', async () => {
  const dir = tmpDir()
  const p = await bootPlugin({
    cfg: { dataDir: dir, personaPath: writeFixturePersona(dir), inject: { mode: 'full', sessionDirs: [HOME] }, emotion: { ingestEnabled: true } },
  })
  const msg = (text, seq) => ({ type: 'user/message', seq, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  p.ctx.emit('session/event', { header: { id: 's-prefix', cwd: HOME } }, msg('[QQ·私聊·某人(1)] 今天很开心，谢谢' + RULES, 1))
  const st = p.service.emotion.state()
  assert.ok(st.valence > 0.05, `渠道头+规矩不应带偏，实际 ${st.valence}`)

  const before = p.service.emotion.state()
  p.ctx.emit('session/event', { header: { id: 's-prefix', cwd: HOME } }, msg('Current runtime context\nTime sampled: x', 2))
  const after = p.service.emotion.state()
  assert.ok(Math.abs(after.valence - before.valence) < 1e-6, '运行时上下文不应改变心情')
})
