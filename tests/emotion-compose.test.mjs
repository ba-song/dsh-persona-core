import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyEmotionConfidence, composeEmotionEpisodes } from '../lib/emotion-compose.js'

const NOW = 1_000_000
const ep = (overrides = {}) => ({
  id: 1, emotion: 'joy', target: 'self', experiencer: 'self',
  at: NOW, intensity: 0.8, half_life_s: 3600,
  expires_at: NOW + 10_000_000, confidence: 0.9,
  ...overrides,
})

test('confidence classification preserves unknown rather than inventing certainty', () => {
  assert.equal(classifyEmotionConfidence(undefined), 'unknown')
  assert.equal(classifyEmotionConfidence(0.7), 'active_candidate')
  assert.equal(classifyEmotionConfidence(0.5), 'appraisal_only')
  assert.equal(classifyEmotionConfidence(0.2), 'uncertain')
})

test('missing experiencer is unknown and never silently becomes self', () => {
  const result = composeEmotionEpisodes([
    ep({ experiencer: undefined, experiencerType: undefined, experiencer_type: undefined }),
  ], { now: NOW })
  assert.equal(result.allEmotions[0].experiencer, 'unknown')
  assert.equal(result.allEmotions[0].experiencerType, 'unknown')
  assert.equal(result.primaryForSelf, null)
})

test('experiencer IDs use bare-ID contract and matching prefixes are not doubled', () => {
  const result = composeEmotionEpisodes([
    ep({ id: 10, experiencerType: 'owner', experiencerId: '123' }),
    ep({ id: 11, experiencerType: 'owner', experiencerId: 'owner:456', emotion: 'sadness' }),
  ], { now: NOW })
  assert.deepEqual(result.allEmotions.map((x) => x.experiencer).sort(), ['owner:123', 'owner:456'])
})

test('a mismatched experiencer ID namespace is rejected', () => {
  const result = composeEmotionEpisodes([
    ep({ experiencerType: 'owner', experiencerId: 'self:123' }),
  ], { now: NOW })
  assert.equal(result.total, 0)
})

test('unknown experiencer always has an empty ID', () => {
  const result = composeEmotionEpisodes([
    ep({ experiencerType: 'unknown', experiencerId: 'x' }),
  ], { now: NOW })
  assert.equal(result.total, 1)
  assert.equal(result.allEmotions[0].experiencer, 'unknown')
  assert.equal(result.allEmotions[0].experiencerId, '')
  assert.equal(result.allEmotions[0].injectable, false)
  assert.equal(result.primaryForSelf, null)
})

test('legacy namespaced experiencer is parsed without treating it as a type', () => {
  const result = composeEmotionEpisodes([
    ep({ experiencer: 'self:1d2', experiencerType: undefined, experiencer_type: undefined }),
  ], { now: NOW })
  assert.equal(result.allEmotions[0].experiencerType, 'self')
  assert.equal(result.allEmotions[0].experiencerId, '1d2')
  assert.equal(result.allEmotions[0].experiencer, 'self:1d2')
})

test('only self-attributed emotions enter the self projection', () => {
  const result = composeEmotionEpisodes([
    ep({ id: 1, experiencerType: 'unknown', experiencerId: 'x' }),
    ep({ id: 2, experiencerType: 'owner', experiencerId: 'owner-1', emotion: 'sadness' }),
    ep({ id: 3, experiencerType: 'third_party', experiencerId: 'person-2', emotion: 'fear' }),
    ep({ id: 4, experiencerType: 'self', experiencerId: 'self-1', emotion: 'anger' }),
  ], { now: NOW })
  assert.deepEqual(result.selfEmotions.map((x) => x.experiencerType), ['self'])
  assert.equal(result.primaryForSelf?.experiencerType, 'self')
  assert.equal(result.selfEmotions[0].injectable, true)
  assert.equal(result.allEmotions.filter((x) => x.experiencerType !== 'self').every((x) => !x.injectable), true)
})

test('same emotion and target merges by maximum decayed intensity, never sum', () => {
  const result = composeEmotionEpisodes([
    ep({ id: 1, intensity: 0.7 }),
    ep({ id: 2, intensity: 0.9, at: NOW - 3600_000 }),
  ], { now: NOW })
  assert.equal(result.total, 1)
  assert.equal(result.emotions[0].intensity, 0.7)
  assert.deepEqual(result.emotions[0].sourceIds, [1, 2])
})

test('same label on different targets remains separate', () => {
  const result = composeEmotionEpisodes([
    ep({ id: 1, target: 'self' }),
    ep({ id: 2, target: 'owner' }),
  ], { now: NOW })
  assert.equal(result.total, 2)
  assert.deepEqual(result.allEmotions.map((x) => x.target).sort(), ['owner', 'self'])
})

test('positive and negative emotions coexist without cancellation', () => {
  const result = composeEmotionEpisodes([
    ep({ id: 1, emotion: 'joy', intensity: 0.8 }),
    ep({ id: 2, emotion: 'sadness', intensity: 0.7 }),
  ], { now: NOW })
  assert.deepEqual(result.allEmotions.map((x) => x.emotion).sort(), ['joy', 'sadness'])
})

test('expired and decayed-below-floor episodes are omitted, source history is untouched', () => {
  const source = [
    ep({ id: 1, expires_at: NOW }),
    ep({ id: 2, at: NOW - 20 * 3600_000, half_life_s: 3600 }),
  ]
  const snapshot = structuredClone(source)
  const result = composeEmotionEpisodes(source, { now: NOW })
  assert.equal(result.total, 0)
  assert.deepEqual(source, snapshot)
})

test('legacy episodes are grandfathered; new low-confidence items are not active', () => {
  const result = composeEmotionEpisodes([
    ep({ id: 1, confidence: 0.5, legacy: true }),
    ep({ id: 2, confidence: 0.5, legacy: false, emotion: 'sadness' }),
    ep({ id: 3, confidence: 0.2, legacy: false, emotion: 'anger' }),
  ], { now: NOW })
  assert.deepEqual(result.allEmotions.map((x) => x.emotion), ['joy'])
  assert.equal(result.allEmotions[0].confidenceClass, 'appraisal_only')
})

test('stable deterministic ordering and explicit pagination metadata', () => {
  const inputs = [
    ep({ id: 3, emotion: 'sadness', intensity: 0.6 }),
    ep({ id: 2, emotion: 'anger', intensity: 0.6 }),
    ep({ id: 1, emotion: 'joy', intensity: 0.6 }),
  ]
  const a = composeEmotionEpisodes(inputs, { now: NOW, displayLimit: 2 })
  const b = composeEmotionEpisodes([...inputs].reverse(), { now: NOW, displayLimit: 2 })
  assert.deepEqual(a.allEmotions.map((x) => x.emotion), b.allEmotions.map((x) => x.emotion))
  assert.equal(a.emotions.length, 2)
  assert.equal(a.total, 3)
  assert.equal(a.hasMore, true)
  assert.equal(a.allEmotions.length, 3)
})

test('invalid arguments fail loudly rather than silently truncating', () => {
  assert.throws(() => composeEmotionEpisodes({}, { now: NOW }), /episodes must be an array/)
  assert.throws(() => composeEmotionEpisodes([], { now: NOW, displayLimit: 0 }), /displayLimit/)
})

test('preserves both episode and appraisal identifiers plus explicit sourceIds', () => {
  const result = composeEmotionEpisodes([
    ep({ id: 12, appraisal_id: 88, appraisalId: 89, episodeId: 13, episode_id: 14, sourceIds: ['raw:4', 'event:5'] }),
  ], { now: NOW })
  assert.deepEqual(result.allEmotions[0].sourceIds, [12, 13, 14, 88, 89, 'event:5', 'raw:4'])
  assert.deepEqual(result.allEmotions[0].sourceRefs, [
    { type: 'appraisal', id: '88', role: 'evidence' },
    { type: 'appraisal', id: '89', role: 'evidence' },
    { type: 'episode', id: '12', role: 'evidence' },
    { type: 'episode', id: '13', role: 'evidence' },
    { type: 'episode', id: '14', role: 'evidence' },
    { type: 'event', id: '5', role: 'evidence' },
    { type: 'raw', id: '4', role: 'evidence' },
  ])
})

test('typed source refs keep equal numeric IDs from different tables distinct', () => {
  const result = composeEmotionEpisodes([
    ep({ id: 7, appraisal_id: 7, sourceIds: ['event:7'] }),
  ], { now: NOW })
  assert.deepEqual(result.allEmotions[0].sourceRefs.map((x) => x.type), ['appraisal', 'episode', 'event'])
  assert.equal(result.allEmotions[0].sourceRefs.length, 3)
})

test('rejects malformed episodes, non-finite expiry, and out-of-range intensity', () => {
  const result = composeEmotionEpisodes([
    null,
    ep({ emotion: '' }),
    ep({ target: '' }),
    ep({ half_life_s: undefined }),
    ep({ intensity: NaN }),
    ep({ intensity: Infinity }),
    ep({ intensity: 1.01 }),
    ep({ intensity: -0.01 }),
    ep({ expires_at: NaN }),
    ep({ expires_at: Infinity }),
  ], { now: NOW })
  assert.equal(result.total, 0)
})

test('confidence outside [0,1] is unknown and cannot activate a new episode', () => {
  assert.equal(classifyEmotionConfidence(-0.1), 'unknown')
  assert.equal(classifyEmotionConfidence(1.1), 'unknown')
  assert.equal(classifyEmotionConfidence(NaN), 'unknown')
  assert.equal(classifyEmotionConfidence(Infinity), 'unknown')
  assert.equal(classifyEmotionConfidence(-Infinity), 'unknown')
  assert.equal(classifyEmotionConfidence(0), 'uncertain')
  assert.equal(classifyEmotionConfidence(1), 'active_candidate')
  const result = composeEmotionEpisodes([
    ep({ confidence: -0.1 }),
    ep({ confidence: 1.1, emotion: 'fear' }),
    ep({ confidence: undefined, emotion: 'sadness' }),
  ], { now: NOW })
  assert.equal(result.total, 0)
})

test('future timestamps have zero age and remain bounded by expiry', () => {
  const result = composeEmotionEpisodes([
    ep({ at: NOW + 5000, intensity: 0.75, expires_at: NOW + 10000 }),
  ], { now: NOW })
  assert.equal(result.total, 1)
  assert.equal(result.allEmotions[0].intensity, 0.75)
})

test('codepoint ordering is stable across input order and retains non-ASCII keys', () => {
  const inputs = [
    ep({ id: 'z', emotion: '情绪', target: '目标' }),
    ep({ id: 'a', emotion: 'anger', target: 'self' }),
    ep({ id: 'b', emotion: 'joy', target: 'owner' }),
  ]
  const a = composeEmotionEpisodes(inputs, { now: NOW })
  const b = composeEmotionEpisodes([...inputs].reverse(), { now: NOW })
  assert.deepEqual(a.allEmotions.map(x => [x.target, x.emotion]), b.allEmotions.map(x => [x.target, x.emotion]))
})

test('displayLimit above total is valid and never drops records', () => {
  const result = composeEmotionEpisodes([ep()], { now: NOW, displayLimit: 1000 })
  assert.equal(result.total, 1)
  assert.equal(result.emotions.length, 1)
  assert.equal(result.hasMore, false)
})
