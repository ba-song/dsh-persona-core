import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAppraisal, strategyText } from '../lib/appraisal.js'

test('appraisal JSON 解析/夹取/策略归一', () => {
  const p = parseAppraisal(JSON.stringify({
    facts: '主人说想我', user_need: '被回应', goal_congruence: 0.8, desirability: 0.9, praiseworthiness: 0.2, threat: 0,
    emotion: 'affection', intensity: 0.7, valence: 0.8, arousal: 0.5, target: 'owner', cause: '主人表达想念',
    strategy: { tone: 'soft', length: 'short', initiative: 'normal', do: ['多说一句心里话'], avoid: ['只回嗯'] },
  }))
  assert.equal(p.ok, true)
  assert.equal(p.emotion, 'affection')
  assert.equal(p.strategy.tone, 'soft')
  const t = strategyText(p)
  assert.ok(t.includes('【这轮表达】'))
  assert.ok(t.includes('软一点'))
  assert.ok(t.includes('别只回嗯'))
})

test('非法 JSON / 未知情绪回落', () => {
  assert.equal(parseAppraisal('not json').ok, false)
  const p = parseAppraisal('{"emotion":"???","intensity":2,"valence":-3,"arousal":9}')
  assert.equal(p.emotion, 'calm')
  assert.equal(p.intensity, 1)
  assert.equal(p.valence, -1)
  assert.equal(p.arousal, 1)
})

test('appraiseByLlm：走宿主 llm，解析出结构化结果；失败返回 null', async () => {
  const { appraiseByLlm } = await import('../lib/appraisal.js')
  const fake = {
    get(n) {
      if (n === 'llm') return {
        prepareCall: async () => ({
          config: {},
          async *stream() { yield { type: 'text-delta', text: '{"emotion":"affection","intensity":0.6,"valence":0.7,"arousal":0.4,"target":"owner","cause":"想我","strategy":{"tone":"soft","length":"short","do":["多说一句"],"avoid":[]}}' } },
        }),
      }
      if (n === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return null
    },
  }
  const p = await appraiseByLlm({ ctx: fake, text: '好想你' })
  assert.equal(p?.emotion, 'affection')
  assert.equal(p?.strategy.tone, 'soft')
  const p2 = await appraiseByLlm({ ctx: { get: () => null }, text: 'x' })
  assert.equal(p2, null)
})
