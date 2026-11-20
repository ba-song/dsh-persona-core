/**
 * EI-1: deterministic, side-effect-free composition of active emotion episodes.
 *
 * This module is intentionally not wired into persistence, appraisal, injection,
 * or the legacy composeEmotionView() path. It is safe to exercise in isolation.
 */

const finite = (value) => Number.isFinite(Number(value)) && value !== null && value !== ''
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value)))
const compareCodepoint = (a, b) => {
  const left = String(a)
  const right = String(b)
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Classify confidence without mutating or deleting the source appraisal.
 * Thresholds are engineering defaults for shadow evaluation, not psychological
 * truths. Missing confidence is explicitly unknown (never silently 1.0).
 */
export function classifyEmotionConfidence(confidence, {
  activeMin = 0.65,
  appraisalMin = 0.45,
} = {}) {
  if (!finite(confidence)) return 'unknown'
  const numericConfidence = Number(confidence)
  if (numericConfidence < 0 || numericConfidence > 1) return 'unknown'
  const value = numericConfidence
  if (value >= activeMin) return 'active_candidate'
  if (value >= appraisalMin) return 'appraisal_only'
  return 'uncertain'
}

function normalizeEpisode(episode, now, options) {
  if (!episode || typeof episode !== 'object') return null
  const emotion = String(episode.emotion ?? episode.label ?? '').trim()
  const target = String(episode.target ?? '').trim()
  const experiencer = String(episode.experiencer ?? 'self').trim()
  const at = Number(episode.at ?? episode.occurredAt ?? episode.occurred_at)
  const intensity = Number(episode.intensity)
  const halfLifeS = Number(episode.halfLifeS ?? episode.half_life_s)
  const expiresAt = Number(episode.expiresAt ?? episode.expires_at)

  if (!emotion || !target || !experiencer) return null
  if (!Number.isFinite(at) || !Number.isFinite(intensity) || intensity < 0 || intensity > 1) return null
  const hasExpiry = episode.expiresAt !== undefined || episode.expires_at !== undefined
  if (hasExpiry && (!Number.isFinite(expiresAt) || expiresAt <= 0)) return null
  if (hasExpiry && expiresAt <= now) return null
  if (!Number.isFinite(halfLifeS) || halfLifeS <= 0) return null

  const confidence = finite(episode.confidence) && Number(episode.confidence) >= 0 && Number(episode.confidence) <= 1
    ? Number(episode.confidence)
    : null
  const legacy = episode.legacy === true || episode.isLegacy === true
  const confidenceClass = classifyEmotionConfidence(confidence, options.thresholds)
  if (!legacy && confidenceClass !== 'active_candidate') return null

  const ageMs = Math.max(0, now - at)
  const decayedIntensity = intensity * Math.pow(0.5, ageMs / (halfLifeS * 1000))
  if (!Number.isFinite(decayedIntensity) || decayedIntensity < options.minIntensity) return null

  return {
    emotion,
    target,
    experiencer,
    intensity: clamp01(decayedIntensity),
    confidence,
    confidenceClass,
    legacy,
    at,
    cause: String(episode.cause ?? ''),
    episodeId: episode.id ?? episode.episodeId ?? null,
    appraisalId: episode.appraisalId ?? episode.appraisal_id ?? null,
    sourceIds: [...new Set([
      episode.id, episode.episodeId, episode.appraisalId, episode.appraisal_id,
      ...(Array.isArray(episode.sourceIds) ? episode.sourceIds : []),
    ].filter((x) => x !== undefined && x !== null && x !== ''))],
  }
}

/**
 * Merge active episodes by (experiencer,target,label). Positive and negative
 * labels are never netted against one another. Duplicate labels use max
 * decayed intensity (not sum) and preserve all source identifiers.
 */
export function composeEmotionEpisodes(episodes, {
  now = Date.now(),
  minIntensity = 0.15,
  thresholds = { activeMin: 0.65, appraisalMin: 0.45 },
  displayLimit = 8,
} = {}) {
  if (!Array.isArray(episodes)) throw new TypeError('episodes must be an array')
  if (!finite(now)) throw new TypeError('now must be a finite timestamp')
  if (!finite(minIntensity) || Number(minIntensity) < 0 || Number(minIntensity) > 1) {
    throw new RangeError('minIntensity must be within [0,1]')
  }
  if (!Number.isInteger(displayLimit) || displayLimit < 1) {
    throw new RangeError('displayLimit must be a positive integer')
  }

  const options = { minIntensity: Number(minIntensity), thresholds }
  const merged = new Map()
  for (const episode of episodes) {
    const item = normalizeEpisode(episode, Number(now), options)
    if (!item) continue
    const key = JSON.stringify([item.experiencer, item.target, item.emotion])
    const current = merged.get(key)
    if (!current) {
      merged.set(key, item)
      continue
    }
    current.intensity = Math.max(current.intensity, item.intensity)
    if (item.confidence !== null) {
      current.confidence = current.confidence === null
        ? item.confidence
        : Math.max(current.confidence, item.confidence)
    }
    current.legacy = current.legacy && item.legacy
    current.at = Math.max(current.at, item.at)
    current.sourceIds.push(...item.sourceIds)
    current.sourceIds = [...new Set(current.sourceIds)].sort((a, b) => compareCodepoint(a, b))
    if (item.cause && (!current.cause || compareCodepoint(item.cause, current.cause) < 0)) current.cause = item.cause
  }

  const emotions = [...merged.values()].map((item) => ({
    ...item,
    sourceIds: [...new Set(item.sourceIds)].sort((a, b) => compareCodepoint(a, b)),
    rankScore: item.intensity * (item.confidence ?? 0),
  }))
  emotions.sort((a, b) =>
    b.rankScore - a.rankScore ||
    b.intensity - a.intensity ||
    (b.confidence ?? -1) - (a.confidence ?? -1) ||
    b.at - a.at ||
    compareCodepoint(a.target, b.target) ||
    compareCodepoint(a.emotion, b.emotion) ||
    compareCodepoint(a.experiencer, b.experiencer),
  )

  const primary = emotions[0] ?? null
  const visible = emotions.slice(0, displayLimit)
  return {
    emotions: visible,
    primary,
    total: emotions.length,
    hasMore: emotions.length > visible.length,
    // The full active set is returned separately so callers can paginate
    // without losing lower-ranked emotions or their source associations.
    allEmotions: emotions,
  }
}
