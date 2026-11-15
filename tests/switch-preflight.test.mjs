/** 切换预演：NOT_READY 判定、双份风险、原子计划、脚本只读。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERDICT, evaluateSwitch, personaLayers, renderSwitchReport } from '../lib/preflight.js'
import { tmpDir } from './helpers/fixtures.mjs'

const SCRIPT = new URL('../scripts/switch-preflight.mjs', import.meta.url).pathname

const READY_BASE = {
  settings: { persona: '', personaMode: 'external', directPrompt: '' },
  personaCfg: { inject: { mode: 'brief', sessionDirs: [{ dir: '/tmp/conv', mode: 'brief' }] } },
  promptsText: 'const external = (config?.personaMode ?? "onebot") === "external"',
  hostMounted: true,
  emotionMigrated: true,
  blindEvalDone: true,
  personaFileText: '# 我是谁\n名字：{{display_name}}\n',
}

test('全绿 → READY', () => {
  const r = evaluateSwitch(READY_BASE)
  assert.equal(r.verdict, VERDICT.READY, JSON.stringify(r.blockers))
  assert.equal(r.blockers.length, 0)
  assert.equal(r.current.duplicateLayers.length, 1, '只有插件一层，不算双份')
  assert.ok(!r.current.duplicateLayers.some((l) => l.includes('onebot')))
})

test('directPrompt 非空只是提示，不阻塞（行为指令≠人设）', () => {
  const r = evaluateSwitch({ ...READY_BASE, settings: { ...READY_BASE.settings, directPrompt: '做事别出声' } })
  assert.equal(r.verdict, VERDICT.READY_WITH_WARNINGS)
  assert.ok(r.warnings.some((w) => w.code === 'EXTRA_PROMPTS'))
  assert.ok(!r.blockers.some((b) => b.code === 'EXTRA_PROMPTS'))
})

test('双份人设：onebot persona + 插件 full 同时在 → 警告 DOUBLE_PERSONA', () => {
  const r = evaluateSwitch({
    ...READY_BASE,
    settings: { persona: '我是鲸鱼娘', personaMode: 'onebot' },
    personaCfg: { inject: { mode: 'full', sessionDirs: ['/tmp/conv'] } },
    promptsText: 'personaMode',
  })
  assert.equal(r.verdict, VERDICT.READY_WITH_WARNINGS)
  assert.ok(r.warnings.some((w) => w.code === 'DOUBLE_PERSONA'))
  assert.equal(r.current.onebotPersonaChars, '我是鲸鱼娘'.length)
})

test('双份分层函数', () => {
  assert.equal(personaLayers({ settingsPersona: 'x', pluginMode: 'full', allowlisted: true }).length, 2)
  assert.equal(personaLayers({ settingsPersona: '', pluginMode: 'full', allowlisted: true }).length, 1)
  assert.equal(personaLayers({ settingsPersona: 'x', pluginMode: 'off', allowlisted: true }).length, 1)
  assert.equal(personaLayers({ settingsPersona: 'x', pluginMode: 'full', allowlisted: false }).length, 1, '未白名单不会真注入')
})

test('NOT_READY：onebot prompts.js 不支持 personaMode', () => {
  const r = evaluateSwitch({ ...READY_BASE, promptsText: 'const persona = config.persona' })
  assert.equal(r.verdict, VERDICT.NOT_READY)
  assert.ok(r.blockers.some((b) => b.code === 'ONEBOT_NO_PERSONA_MODE'))
  assert.match(renderSwitchReport(r), /ANON_RULE/)
})

test('NOT_READY：插件未挂载 / mode=off / 白名单空 / persona 空 / 状态自相矛盾', () => {
  const cases = [
    [{ hostMounted: false }, 'HOST_NOT_MOUNTED'],
    [{ personaCfg: { inject: { mode: 'off', sessionDirs: ['/x'] } } }, 'PLUGIN_MODE_OFF'],
    [{ personaCfg: { inject: { mode: 'brief', sessionDirs: [] } } }, 'ALLOWLIST_EMPTY'],
    [{ personaFileText: '   ' }, 'PERSONA_EMPTY'],
    [{ settings: { persona: '还有内容', personaMode: 'external' }, promptsText: 'personaMode' }, 'MODE_EXTERNAL_BUT_PERSONA_SET'],
  ]
  for (const [patch, code] of cases) {
    const r = evaluateSwitch({ ...READY_BASE, ...patch })
    assert.equal(r.verdict, VERDICT.NOT_READY, `${code} 应 NOT_READY`)
    assert.ok(r.blockers.some((b) => b.code === code), `缺 ${code}：${JSON.stringify(r.blockers)}`)
  }
})

test('计划与回滚写清原子顺序与 5 分钟回滚', () => {
  const r = evaluateSwitch(READY_BASE)
  const planText = r.plan.map((s) => `${s.title}${s.detail}`).join(' ')
  assert.match(planText, /单次重启/)
  assert.match(planText, /personaMode='external'|personaMode/)
  const rollbackText = r.rollback.map((s) => `${s.title}${s.detail}`).join(' ')
  assert.match(rollbackText, /≤5 分钟/)
  assert.ok(r.rollback.some((s) => /settings/.test(s.title + s.detail)))
})

test('脚本只读：运行前后输入文件 sha256 不变，且不改任何配置', () => {
  const dir = tmpDir()
  const settings = join(dir, 'settings.json')
  const prompts = join(dir, 'prompts.js')
  const personaMd = join(dir, 'persona.md')
  const cfg = join(dir, 'persona-cfg.json')
  writeFileSync(settings, JSON.stringify({ persona: '我是鲸鱼娘', directPrompt: 'x' }), 'utf8')
  writeFileSync(prompts, 'function buildChatPrompt(config){ const persona = config.persona }', 'utf8')
  writeFileSync(personaMd, '# 我是谁\n名字：{{display_name}}\n', 'utf8')
  writeFileSync(cfg, JSON.stringify({ inject: { mode: 'brief', sessionDirs: ['/tmp/conv'] } }), 'utf8')

  const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
  const before = [settings, prompts, personaMd, cfg].map(hash)
  let failed = false
  try {
    execFileSync(
      process.execPath,
      [SCRIPT, `--settings=${settings}`, `--prompts=${prompts}`, `--persona-md=${personaMd}`, `--persona-config=${cfg}`],
      { encoding: 'utf8' },
    )
  } catch (error) {
    failed = error.status === 1 // NOT_READY 用退出码 1 表达
    assert.match(String(error.stdout ?? ''), /判定：NOT_READY/)
    assert.match(String(error.stdout ?? ''), /ONEBOT_NO_PERSONA_MODE/)
  }
  assert.equal(failed, true, '缺 personaMode 时应以退出码 1 结束')
  const after = [settings, prompts, personaMd, cfg].map(hash)
  assert.deepEqual(after, before, '预演脚本不得修改输入文件')
})

test('脚本 --json 输出可解析，且不改文件', () => {
  const dir = tmpDir()
  const settings = join(dir, 'settings.json')
  const prompts = join(dir, 'prompts.js')
  writeFileSync(settings, JSON.stringify({ persona: '', personaMode: 'external' }), 'utf8')
  writeFileSync(prompts, 'const external = config.personaMode === "external"', 'utf8')
  let out = ''
  try {
    out = execFileSync(process.execPath, [SCRIPT, `--settings=${settings}`, `--prompts=${prompts}`, '--host-mounted', '--json'], {
      encoding: 'utf8',
    })
  } catch (error) {
    out = String(error.stdout ?? '')
    assert.equal(error.status, 1, 'NOT_READY 应以退出码 1 结束')
  }
  const parsed = JSON.parse(out.slice(out.indexOf('{')))
  assert.equal(parsed.verdict, VERDICT.NOT_READY, '没给 persona 配置 → mode=off/白名单空')
  assert.ok(parsed.blockers.some((b) => b.code === 'PLUGIN_MODE_OFF'))
})
