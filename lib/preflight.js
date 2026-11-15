/**
 * onebot 人设切换预演：纯函数，只做判定，不读写任何文件。
 *
 * 目标：在真正切 onebot 之前回答三件事
 *  1) 现在是不是「双份人设」（onebot persona + 人格插件同时注入）
 *  2) 能不能切（缺哪个前置就 NOT_READY）
 *  3) 切/回滚的原子顺序（同一重启内完成，避免中间态）
 *
 * 输入都是「已读出来的快照」，函数内不碰文件系统，方便测试与 dry-run。
 */

export const VERDICT = { READY: 'READY', READY_WITH_WARNINGS: 'READY_WITH_WARNINGS', NOT_READY: 'NOT_READY' }

/** 双份风险分层：onebot 人设层 + 插件人格层。 */
export function personaLayers({ settingsPersona, pluginMode, allowlisted }) {
  const layers = []
  if (String(settingsPersona ?? '').trim()) layers.push({ kind: 'onebot', label: 'onebot settings.persona' })
  if (String(pluginMode ?? 'off') !== 'off' && allowlisted) layers.push({ kind: 'plugin', label: `人格插件 dy-persona（${pluginMode}）` })
  return layers
}

function step(id, title, detail) {
  return { id, title, detail }
}

/**
 * @param {object} input
 * @param {object} input.settings            onebot settings.json 的解析结果
 * @param {object} input.personaCfg          { inject: { mode, sessionDirs }, personaPath }
 * @param {string} input.promptsText         prompts.js 源码（用于判断是否支持 personaMode）
 * @param {boolean} input.hostMounted        人格插件是否已进 profile 并被宿主加载
 * @param {boolean} [input.emotionMigrated]  情绪是否已迁移
 * @param {boolean} [input.blindEvalDone]    是否已完成盲评
 * @param {string} [input.personaFileText]   persona.md 内容（判断是否为空）
 * @returns {{verdict:string, blockers:Array, warnings:Array, current:object, plan:Array, rollback:Array}}
 */
export function evaluateSwitch({
  settings = {},
  personaCfg = {},
  promptsText = '',
  hostMounted = false,
  emotionMigrated = false,
  blindEvalDone = false,
  personaFileText = '',
} = {}) {
  const blockers = []
  const warnings = []

  const onebotPersona = String(settings.persona ?? '').trim()
  const personaMode = settings.personaMode
  const inject = personaCfg.inject ?? {}
  const mode = String(inject.mode ?? 'off')
  const dirs = Array.isArray(inject.sessionDirs) ? inject.sessionDirs : []
  const allowlisted = dirs.length > 0
  const promptsHasMode = /personaMode/.test(String(promptsText ?? ''))
  const layers = personaLayers({ settingsPersona: onebotPersona, pluginMode: mode, allowlisted })

  const current = {
    onebotPersonaChars: onebotPersona.length,
    directPromptChars: String(settings.directPrompt ?? '').trim().length,
    groupPromptChars: String(settings.groupPrompt ?? '').trim().length,
    personaMode: personaMode ?? '(缺失)',
    pluginMode: mode,
    allowlistCount: dirs.length,
    duplicateLayers: layers.map((l) => l.label),
    promptsSupportsPersonaMode: promptsHasMode,
    hostMounted: Boolean(hostMounted),
    personaFileEmpty: !String(personaFileText ?? '').trim(),
    emotionMigrated: Boolean(emotionMigrated),
  }

  // ── 阻塞项 ─────────────────────────────────────────────
  if (!hostMounted) {
    blockers.push({
      code: 'HOST_NOT_MOUNTED',
      message: '人格插件未挂载到 profile / 宿主未加载：切换后没有任何人格来源',
      fix: '由统筹者按 host 门禁把 dsh-persona-core 加进 bundles 并重启（P 不改 profile）',
    })
  }
  if (!promptsHasMode) {
    blockers.push({
      code: 'ONEBOT_NO_PERSONA_MODE',
      message: 'onebot prompts.js 不支持 personaMode：清空 settings.persona 会命中 ANON_RULE（「你没有固定名字」）',
      fix: '由 onebot 负责人加 personaMode=external 分支（跳过 SELF_KNOWN_RULE/ANON_RULE）；P 不改 onebot 源码',
    })
  }
  if (mode === 'off') {
    blockers.push({
      code: 'PLUGIN_MODE_OFF',
      message: `人格插件 inject.mode=${mode}：切换后 onebot 与插件都不出人格`,
      fix: '先设 inject.mode=brief 并重启验证',
    })
  }
  if (!allowlisted) {
    blockers.push({
      code: 'ALLOWLIST_EMPTY',
      message: 'inject.sessionDirs 为空：插件不会往任何会话注入',
      fix: '显式配置「汐的会话目录」（不含 QQ 号的路径白名单）',
    })
  }
  if (current.personaFileEmpty) {
    blockers.push({
      code: 'PERSONA_EMPTY',
      message: 'persona.md 为空或不存在：插件注入块为空',
      fix: '确认 /sdcard/DSHA/人格/数据/persona.md 有内容',
    })
  }
  if (onebotPersona && personaMode === 'external') {
    blockers.push({
      code: 'MODE_EXTERNAL_BUT_PERSONA_SET',
      message: 'personaMode 已是 external，但 settings.persona 仍有内容：一份会被忽略，容易误判',
      fix: '两者同时改：persona 置空 + personaMode=external',
    })
  }

  // ── 警告 ────────────────────────────────────────────────
  if (layers.length >= 2) {
    warnings.push({
      code: 'DOUBLE_PERSONA',
      message: `当前存在 ${layers.length} 层人设同时生效：${layers.map((l) => l.label).join(' + ')}`,
    })
  }
  if (current.directPromptChars > 0 || current.groupPromptChars > 0) {
    warnings.push({
      code: 'EXTRA_PROMPTS',
      message: `directPrompt(${current.directPromptChars} 字)/groupPrompt(${current.groupPromptChars} 字) 仍在：它们是行为指令不是人设，切换后保留；需确认里面没有自我介绍`,
    })
  }
  if (!emotionMigrated) {
    warnings.push({
      code: 'EMOTION_NOT_MIGRATED',
      message: '情绪数据未迁移：dy-emotion 块会一直为空（不影响人格切换，但看不到心情）',
    })
  }
  if (!blindEvalDone) {
    warnings.push({ code: 'NO_BLIND_EVAL', message: '没有盲评记录：切换后需按 10 组样本对比「像不像她」' })
  }

  const verdict = blockers.length ? VERDICT.NOT_READY : warnings.length ? VERDICT.READY_WITH_WARNINGS : VERDICT.READY

  // ── 原子切换计划（一次重启内完成，不留中间态）──────────
  const plan = [
    step(0, '备份', 'settings.json、persona 插件配置、persona.db（如已建）；记录 sha256'),
    step(1, '改插件配置', "inject.mode='brief'；sessionDirs 只加「汐的会话目录」；不设 required（默认就不设）"),
    step(2, '改 onebot settings', "persona='' 且 personaMode='external' —— 同一个文件、同一次保存改完"),
    step(3, '单次重启', '两个改动在同一次重启生效：不存在「两边都没人设」的窗口'),
    step(4, '验证 prompt 快照', '【人格核心】出现 1 次；无 ANON_RULE；无第二份「我是谁」；事实卡只有一份'),
    step(5, '观察 24h', '记录空注入次数、双份告警、盲评 10 组'),
    step(6, '升 full', "盲评通过后把 inject.mode 改 'full'（需要再重启一次，此时 brief 已在跑，风险低）"),
  ]

  const rollback = [
    step('R1', '回滚 onebot', "settings.json 恢复备份（persona 原文 + 删掉 personaMode）"),
    step('R2', '回滚插件', "inject.mode 恢复 'off'（或恢复备份的配置）"),
    step('R3', '重启并验证', 'prompt 里 SELF_KNOWN_RULE 回来、【人格核心】消失'),
    step('R4', '时限', '目标 ≤5 分钟；回滚不动 persona.db、不动情绪数据，属于显示层回退'),
  ]

  if (verdict !== VERDICT.READY && verdict !== VERDICT.READY_WITH_WARNINGS) {
    plan.unshift(step('PRE', '修复阻塞项', blockers.map((b) => b.code).join(', ')))
  }

  return { verdict, blockers, warnings, current, plan, rollback }
}

/** 把判定结果渲染成人类可读文本（脚本与报告共用）。 */
export function renderSwitchReport(result) {
  const lines = []
  lines.push(`判定：${result.verdict}`)
  lines.push('')
  lines.push('当前状态：')
  const c = result.current
  lines.push(`  onebot settings.persona：${c.onebotPersonaChars} 字${c.onebotPersonaChars ? '（有内容）' : '（空）'}`)
  lines.push(`  personaMode：${c.personaMode} ｜ prompts.js 支持：${c.promptsSupportsPersonaMode ? '是' : '否'}`)
  lines.push(`  插件 inject.mode：${c.pluginMode} ｜ sessionDirs：${c.allowlistCount}`)
  lines.push(`  双份人设层：${c.duplicateLayers.length ? c.duplicateLayers.join(' + ') : '无'}`)
  lines.push(`  宿主已挂载：${c.hostMounted ? '是' : '否'} ｜ persona.md 空：${c.personaFileEmpty ? '是' : '否'}`)
  lines.push('')
  if (result.blockers.length) {
    lines.push('阻塞项（缺一项就 NOT_READY）：')
    for (const b of result.blockers) lines.push(`  - [${b.code}] ${b.message}\n      修法：${b.fix}`)
    lines.push('')
  }
  if (result.warnings.length) {
    lines.push('警告：')
    for (const w of result.warnings) lines.push(`  - [${w.code}] ${w.message}`)
    lines.push('')
  }
  lines.push('原子切换计划：')
  for (const s of result.plan) lines.push(`  ${s.id}. ${s.title}：${s.detail}`)
  lines.push('')
  lines.push('回滚：')
  for (const s of result.rollback) lines.push(`  ${s.id}. ${s.title}：${s.detail}`)
  return lines.join('\n')
}
