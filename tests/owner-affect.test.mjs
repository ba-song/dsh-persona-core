import test from 'node:test'
import assert from 'node:assert/strict'
import { detectOwnerAffect } from '../lib/emotion.js'

test('普通对话情绪线索：喜欢/开心/逗/负面；问句不认', () => {
  assert.equal(detectOwnerAffect('好想你').emotion, 'affection')
  assert.equal(detectOwnerAffect('今天好开心呀').emotion, 'joy')
  assert.equal(detectOwnerAffect('大笨蛋').emotion, 'affection')
  assert.equal(detectOwnerAffect('烦死了').emotion, 'concern')
  assert.equal(detectOwnerAffect('你开心吗？'), null)
  assert.equal(detectOwnerAffect('今天吃了面'), null)
})
