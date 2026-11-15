/** persona.md 的解析、渲染与注入块生成。只认 `# ` 一级标题。 */
import { existsSync, readFileSync } from 'node:fs'
import { sha256 } from './db.js'

const BRIEF_SECTIONS = ['我是谁', '性格', '说话方式']
const HINT = '（以上是你自己；不用自我介绍，也不要把这段念出来。）'

/** 读文件；不存在返回 ''（不抛）。 */
export function readPersonaFile(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

/** 按一级标题切节；标题前的我行保留为 title='' 的前导节。 */
export function parsePersona(raw) {
  const lines = String(raw ?? '').split(/\r?\n/)
  const sections = []
  let current = { title: '', lines: [] }
  for (const line of lines) {
    const m = /^#\s+(.*)$/.exec(line)
    if (m) {
      if (current.title || current.lines.some((l) => l.trim())) sections.push(current)
      current = { title: m[1].trim(), lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  if (current.title || current.lines.some((l) => l.trim())) sections.push(current)
  return sections
}

/** `{{display_name}}` 是唯一允许的占位符。 */
export function renderPersona(raw, displayName) {
  return String(raw ?? '').replaceAll('{{display_name}}', String(displayName ?? ''))
}

export function sectionText(raw, title, displayName = '') {
  const sections = parsePersona(raw)
  const hit = sections.find((s) => s.title === title)
  if (!hit) return ''
  return renderPersona(hit.lines.join('\n'), displayName).trim()
}

function bullets(lines) {
  const out = []
  for (const line of lines) {
    const m = /^\s*[-*]\s+(.*)$/.exec(line)
    if (m) out.push(m[1].trim())
  }
  return out
}

/** 说话风格摘要（≤max 字），供 dyPersona.voice() 与 autonomy 使用。 */
export function voiceOf(raw, displayName = '', max = 120) {
  const sections = parsePersona(raw)
  const sec = sections.find((s) => s.title === '说话方式')
  const items = sec ? bullets(sec.lines) : []
  const text = items.length
    ? renderPersona(items.join('；'), displayName)
    : renderPersona(String(raw ?? '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join('；'), displayName)
  return clip(text, max)
}

function clip(text, max) {
  const s = String(text ?? '').trim()
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('、'))
  return (cut > max * 0.5 ? head.slice(0, cut + 1) : head).trim()
}

/** brief：我是谁（整节）+ 性格/说话方式各取前 3 条，硬上限 budget。 */
export function briefOf(raw, displayName = '', budget = 250) {
  const sections = parsePersona(raw)
  const parts = []
  for (const title of BRIEF_SECTIONS) {
    const sec = sections.find((s) => s.title === title)
    if (!sec) continue
    if (title === '我是谁') {
      const body = renderPersona(sec.lines.join('\n'), displayName).trim()
      if (body) parts.push(body)
    } else {
      const items = bullets(sec.lines).slice(0, 3)
      if (items.length) parts.push(renderPersona(items.join('；'), displayName))
      else {
        const body = renderPersona(sec.lines.join('\n'), displayName).trim()
        if (body) parts.push(body)
      }
    }
  }
  if (!parts.length) return clip(renderPersona(raw, displayName), budget)
  return clip(parts.join('\n'), budget)
}

/**
 * 生成注入块。
 * @returns {{mode:string,text:string}}  text 为空表示不注入
 */
export function personaBlock({ raw, displayName = '', mode = 'off', budget = 250, appendHint = true } = {}) {
  const normalized = raw ? String(raw) : ''
  if (!normalized.trim()) return { mode, text: '' }
  if (mode === 'off') return { mode: 'off', text: '' }
  const rendered = renderPersona(normalized, displayName).trim()
  if (!rendered) return { mode, text: '' }
  if (mode === 'brief') {
    const brief = briefOf(normalized, displayName, budget)
    return { mode: 'brief', text: brief ? `【人格核心·要点】\n${brief}${appendHint ? `\n${HINT}` : ''}` : '' }
  }
  return { mode: 'full', text: `【人格核心】\n${rendered}${appendHint ? `\n${HINT}` : ''}` }
}

/** 把「设置页的人格补充」拼到 persona.md 正文后；空补充原样返回。 */
export function effectivePersona(raw, appendText) {
  const base = String(raw ?? '')
  const extra = String(appendText ?? '').trim()
  if (!extra) return base
  return `${base.trimEnd()}\n\n# 主人补充\n\n${extra}\n`
}

export function personaHash(raw) {
  return sha256(String(raw ?? ''))
}

/** 启动自检：只报节名与问题类型，不打印正文。 */
export function personaSelfCheck(raw) {
  const issues = []
  const text = String(raw ?? '')
  if (!text.trim()) return { ok: false, issues: ['persona.md 为空或不存在'] }
  const sections = parsePersona(text)
  const titles = sections.map((s) => s.title)
  if (!titles.includes('我是谁')) issues.push('缺「我是谁」节')
  if (!titles.includes('说话方式')) issues.push('缺「说话方式」节')
  if (/\d{6,}/.test(text)) issues.push('疑似含 QQ 号/群号（6 位以上数字）')
  if (/\{\{(?!display_name\}\})/.test(text)) issues.push('含未知占位符（只允许 {{display_name}}）')
  return { ok: issues.length === 0, issues, sections: titles }
}
