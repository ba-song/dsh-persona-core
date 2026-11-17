/**
 * 情绪注入可观测性：阈值 0.35 下的「连续为空」观测。
 *
 * 背景：迁移后线上强度约 0.27 < 0.35，dy-emotion 会一直是空串（不报错，但看不到心情）。
 * 这里只在内存里计数，不写库；连续为空达到 warnEvery 时告警一次，非空即清零。
 */
export function createEmotionObserver({ threshold = 0.35, warnEvery = 20, log } = {}) {
  const stats = {
    calls: 0,
    empty: 0,
    emptyStreak: 0,
    maxEmptyStreak: 0,
    warnings: 0,
    lastNonEmptyAt: 0,
    threshold: Number(threshold),
  }
  const every = Math.max(1, Number(warnEvery) || 20)

  return {
    /** 采样一次注入文本；原样返回，便于直接放在 text() 里。 */
    sample(line) {
      const text = String(line ?? '')
      stats.calls += 1
      if (text.trim()) {
        stats.emptyStreak = 0
        stats.lastNonEmptyAt = Date.now()
        return line
      }
      stats.empty += 1
      stats.emptyStreak += 1
      if (stats.emptyStreak > stats.maxEmptyStreak) stats.maxEmptyStreak = stats.emptyStreak
      if (stats.emptyStreak % every === 0) {
        stats.warnings += 1
        log?.warn?.(
          `[persona] 情绪块连续 ${stats.emptyStreak} 次为空（强度低于阈值 ${stats.threshold}）：` +
            `要么调 emotion.threshold，要么确认情绪输入没被过滤`,
        )
      }
      return line
    },
    /** 只读快照，供 dy_persona_mode / 运维查看。 */
    stats() {
      return {
        ...stats,
        emptyRatio: stats.calls ? Number((stats.empty / stats.calls).toFixed(3)) : 0,
        warnEvery: every,
      }
    },
  }
}
