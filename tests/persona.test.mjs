/** 人格文件：解析/渲染/brief/voice/空文件/自检。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  briefOf,
  parsePersona,
  personaBlock,
  personaSelfCheck,
  readPersonaFile,
  renderPersona,
  sectionText,
  voiceOf,
} from '../lib/persona.js'
import { FIXTURE_PERSONA, tmpDir, writeFixturePersona } from './helpers/fixtures.mjs'

test('解析：按一级标题切节，且标题顺序稳定', () => {
  const sections = parsePersona(FIXTURE_PERSONA)
  assert.deepEqual(sections.map((s) => s.title), ['我是谁', '性格', '说话方式', '边界'])
})

test('渲染：只替换 {{display_name}}', () => {
  const out = renderPersona('名字：{{display_name}}；{{unknown}}', '小汐')
  assert.match(out, /名字：小汐/)
  assert.match(out, /\{\{unknown\}\}/, '未知占位符原样保留（自检会提示）')
})

test('F3 空文件/不存在：personaText 为空、注入块为空串', () => {
  const dir = tmpDir()
  const missing = join(dir, 'nope.md')
  assert.equal(readPersonaFile(missing), '')
  const block = personaBlock({ raw: '', displayName: '汐', mode: 'full' })
  assert.equal(block.text, '')
  const blank = personaBlock({ raw: '   \n\n', displayName: '汐', mode: 'brief' })
  assert.equal(blank.text, '')
})

test('N2 full 注入块含人格核心且渲染当前名字', () => {
  const block = personaBlock({ raw: FIXTURE_PERSONA, displayName: '小汐', mode: 'full' })
  assert.equal(block.mode, 'full')
  assert.match(block.text, /^【人格核心】/)
  assert.match(block.text, /名字：小汐/)
  assert.doesNotMatch(block.text, /\{\{display_name\}\}/)
})

test('brief 档 ≤ 预算且包含身份与说话方式要点', () => {
  const block = personaBlock({ raw: FIXTURE_PERSONA, displayName: '汐', mode: 'brief', budget: 120 })
  assert.equal(block.mode, 'brief')
  const body = block.text.replace(/^【人格核心·要点】\n/, '')
  assert.ok(body.length <= 120, `brief 长度 ${body.length} 应 ≤120`)
  assert.match(body, /测试用鲸鱼娘|名字：汐/)
  assert.match(body, /说话直|口语/)
})

test('off 档永不产出文本', () => {
  const block = personaBlock({ raw: FIXTURE_PERSONA, displayName: '汐', mode: 'off' })
  assert.deepEqual(block, { mode: 'off', text: '' })
})

test('voice ≤120 字且取自说话方式节', () => {
  const voice = voiceOf(FIXTURE_PERSONA, '汐')
  assert.ok(voice.length > 0 && voice.length <= 120, `voice 长度 ${voice.length}`)
  assert.match(voice, /口语|不用表格/)
})

test('sectionText 命中/未命中', () => {
  assert.match(sectionText(FIXTURE_PERSONA, '说话方式', '汐'), /口语/)
  assert.equal(sectionText(FIXTURE_PERSONA, '不存在', '汐'), '')
})

test('briefOf 缺节时回退为全文截断', () => {
  const raw = '# 备注\n\n- 只有一节\n'
  const brief = briefOf(raw, '汐', 50)
  assert.ok(brief.length <= 50)
  assert.match(brief, /只有一节/)
})

test('自检：缺节/含 6 位数字/未知占位符都会被点出（不回显正文）', () => {
  const ok = personaSelfCheck(FIXTURE_PERSONA)
  assert.equal(ok.ok, true, JSON.stringify(ok.issues))
  const bad = personaSelfCheck('# 我是谁\n\n- 联系 123456789\n- {{nickname}}\n')
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.some((i) => i.includes('QQ')))
  assert.ok(bad.issues.some((i) => i.includes('占位符')))
  assert.ok(bad.issues.some((i) => i.includes('说话方式')))
  assert.equal(JSON.stringify(bad).includes('123456789'), false, '自检结果不得回显数字')
})

test('读文件：真实路径可读（不存在的路径返回空串）', () => {
  const dir = tmpDir()
  const path = writeFixturePersona(dir)
  assert.match(readPersonaFile(path), /测试用鲸鱼娘/)
})
