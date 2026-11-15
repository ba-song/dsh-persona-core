import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, isGroupDir, resolveScope } from '../lib/scope.js'
import { effectivePersona, personaBlock } from '../lib/persona.js'

test('群判据：认得 qq-群/<群号> 与 群_ 前缀，不误伤私聊', () => {
  assert.equal(isGroupDir('/sdcard/DSHA/渠道/qq-群/707380948'), true)
  assert.equal(isGroupDir('/sdcard/DSHA/渠道/qq-群'), true)
  assert.equal(isGroupDir('/sdcard/DSHA/生活/数据/home'), false)
  assert.equal(isGroupDir('/sdcard/DSHA/渠道/qq-私聊/2971030080'), false)
  assert.equal(classify({ cwd: '/sdcard/DSHA/渠道/qq-群/707380948' }), 'group')
  assert.equal(resolveScope({ cwd: '/sdcard/DSHA/渠道/qq-群/707380948' }, { inject: { groupMode: 'off' } }).allow, false)
})

test('人格补充：拼在正文后；空补充不改原文', () => {
  const base = '# 我是谁\n\n我是汐。\n'
  assert.equal(effectivePersona(base, ''), base)
  assert.equal(effectivePersona(base, '   '), base)
  const withAppend = effectivePersona(base, '别端着。')
  assert.ok(withAppend.includes('# 主人补充'))
  assert.ok(withAppend.includes('别端着。'))
  assert.ok(withAppend.startsWith(base.trimEnd()))
  const full = personaBlock({ raw: withAppend, displayName: '汐', mode: 'full' }).text
  assert.ok(full.includes('别端着。'))
})
