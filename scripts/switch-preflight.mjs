#!/usr/bin/env node
/**
 * onebot 人设切换预演（只读，不写任何文件）。
 *
 * 读入当前 onebot settings、persona 插件配置、prompts.js 片段、persona.md，
 * 输出「切 / 不切、风险、缺失前置、原子步骤、回滚步骤」。
 *
 * 用法：
 *   node scripts/switch-preflight.mjs \
 *     --settings=/root/.dsh/dsh-qq/settings.json \
 *     --prompts=/root/.dsh/profiles/web/node_modules/dsh-qq-onebot/src/prompts.js \
 *     --persona-config=/tmp/persona-plugin-config.json \
 *     --persona-md=/sdcard/Documents/DSH记忆档案/persona/persona.md \
 *     [--host-mounted] [--emotion-migrated] [--blind-eval-done] [--json]
 *
 * 退出码：0 = READY / READY_WITH_WARNINGS；1 = NOT_READY；2 = 用法错误。
 */
import { readFileSync, existsSync } from 'node:fs'
import { parseArgs } from './_guard.mjs'
import { VERDICT, evaluateSwitch, renderSwitchReport } from '../lib/preflight.js'

const args = parseArgs()

function readText(path, fallback = '') {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : fallback
  } catch {
    return fallback
  }
}

if (!args.settings) {
  console.error('缺 --settings=<onebot settings.json>（只读）')
  process.exit(2)
}

const settings = (() => {
  const raw = readText(args.settings)
  try {
    return JSON.parse(raw)
  } catch (error) {
    console.error(`settings.json 解析失败：${error.message}`)
    process.exit(2)
  }
})()

const personaCfg = (() => {
  if (!args['persona-config']) return { inject: { mode: 'off', sessionDirs: [] } }
  const raw = readText(String(args['persona-config']))
  try {
    return JSON.parse(raw)
  } catch (error) {
    console.error(`persona 配置解析失败：${error.message}`)
    process.exit(2)
  }
})()

const promptsText = args.prompts ? readText(String(args.prompts)) : ''
const personaFileText = args['persona-md'] ? readText(String(args['persona-md'])) : ''

const result = evaluateSwitch({
  settings,
  personaCfg,
  promptsText,
  hostMounted: args['host-mounted'] === true,
  emotionMigrated: args['emotion-migrated'] === true,
  blindEvalDone: args['blind-eval-done'] === true,
  personaFileText,
})

if (args.json === true) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log('=== onebot 人设切换预演（只读）===')
  console.log(`settings：${args.settings}`)
  console.log(`prompts ：${args.prompts ?? '(未提供，按不支持 personaMode 处理)'}`)
  console.log(`persona.md：${args['persona-md'] ?? '(未提供，按空处理)'}`)
  console.log(`persona 配置：${args['persona-config'] ?? '(未提供，按 mode=off、白名单空处理)'}`)
  console.log('')
  console.log(renderSwitchReport(result))
}

process.exit(result.verdict === VERDICT.NOT_READY ? 1 : 0)
