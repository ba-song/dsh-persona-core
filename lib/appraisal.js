/**
 * 事件评估（2026-11-13）：每轮主人消息 → 结构化 appraisal + 表达策略。
 * 参考 EmoLLM 的 Appraisal Reasoning Graph / st-Emotion 的“另一次 LLM 生成”。
 * 失败/超时返回 null，由调用方回退到规则；不阻塞回复。
 */
import { randomUUID } from 'node:crypto'

export const APPRAISAL_SYSTEM_PROMPT = [
  '你是角色「汐」的情绪评估器。读主人这句话（可带最近几轮），只输出一行严格 JSON，不要代码块、不要解释。',
  '字段：facts(≤40字), user_need(≤30字), goal_congruence(-1..1), desirability(-1..1), praiseworthiness(-1..1), threat(0..1),',
  'emotion(joy|affection|pride|relief|amusement|concern|sadness|anger|anxiety|fear|shy|embarrassment|jealousy|guilt|longing|boredom|irritation),',
  'intensity(0..1), valence(-1..1), arousal(0..1), target(owner|self|tool), cause(≤30字),',
  'strategy:{tone(soft|playful|withdrawn|sharp|neutral),length(short|normal|long),initiative(low|normal|high),do:[≤2条],avoid:[≤2条]}}',
  'attunement(可选，没把握就不给)：{intent(listen|practical|answer|repair|space|playful|uncertain), user_cue(≤40字), uncertainty(≤40字), avoid(≤2条)}',
  '规则：情绪来自“这件事对汐的目标/需求意味着什么”，不是复述主人的词；普通闲聊也要给低强度情绪；不要编造事实。',
  'attunement 只写“这轮我怎么理解主人”的简短决定，不写推理过程、不做心理诊断；宁可给 uncertain 也不要猜。',
].join('\n')

const EMOTIONS = new Set(['joy','affection','pride','relief','amusement','concern','sadness','anger','anxiety','fear','shy','embarrassment','jealousy','guilt','longing','boredom','irritation','calm'])
const TONES = new Set(['soft','playful','withdrawn','sharp','neutral'])
const LENGTHS = new Set(['short','normal','long'])
const INIT = new Set(['low','normal','high'])
const TARGETS = new Set(['owner','self','tool'])
const clamp = (x, a, b) => Math.max(a, Math.min(b, Number(x) || 0))
const arr = (x, n = 2) => (Array.isArray(x) ? x : []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, n)

const INTENTS = new Set(['listen', 'practical', 'answer', 'repair', 'space', 'playful', 'uncertain'])
const ATTN_MAX = 500

/**
 * attunement 宽松解析（2026-11-16）：字段缺/类型不对都不抛，整条无效返回 null。
 * 长度上限 500 是结构性的"防 CoT"手段（写不下推理链，只能写决定）——见 Anima models.py:177-187。
 */
export function parseAttunement(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const clip = (v) => String(v ?? '').trim().slice(0, ATTN_MAX)
  const intentRaw = String(raw.intent ?? '').trim()
  const intent = INTENTS.has(intentRaw) ? intentRaw : ''
  const userCue = clip(raw.user_cue ?? raw.userCue)
  const uncertainty = clip(raw.uncertainty)
  const avoid = Array.isArray(raw.avoid)
    ? raw.avoid.map((x) => String(x ?? '').trim().slice(0, 80)).filter(Boolean).slice(0, 2)
    : []
  if (!intent && !userCue && !uncertainty && !avoid.length) return null
  return { intent, user_cue: userCue, uncertainty, avoid }
}

export function parseAppraisal(raw) {
  let s = String(raw ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  let o
  try { o = JSON.parse(s) } catch { return { ok: false, reason: 'parse' } }
  if (!o || typeof o !== 'object') return { ok: false, reason: 'parse' }
  const emotion = EMOTIONS.has(String(o.emotion)) ? String(o.emotion) : 'calm'
  const attunement = parseAttunement(o.attunement)
  const strategyRaw = o.strategy && typeof o.strategy === 'object' ? o.strategy : {}
  const strategy = {
    tone: TONES.has(String(strategyRaw.tone)) ? String(strategyRaw.tone) : 'neutral',
    length: LENGTHS.has(String(strategyRaw.length)) ? String(strategyRaw.length) : 'normal',
    initiative: INIT.has(String(strategyRaw.initiative)) ? String(strategyRaw.initiative) : 'normal',
    do: arr(strategyRaw.do),
    avoid: arr(strategyRaw.avoid),
  }
  return {
    ok: true,
    facts: String(o.facts ?? '').slice(0, 80),
    userNeed: String(o.user_need ?? '').slice(0, 60),
    goalCongruence: clamp(o.goal_congruence, -1, 1),
    desirability: clamp(o.desirability, -1, 1),
    praiseworthiness: clamp(o.praiseworthiness, -1, 1),
    threat: clamp(o.threat, 0, 1),
    emotion,
    intensity: clamp(o.intensity, 0, 1) || 0.3,
    valence: clamp(o.valence, -1, 1),
    arousal: clamp(o.arousal, 0, 1) || 0.3,
    target: TARGETS.has(String(o.target)) ? String(o.target) : 'owner',
    cause: String(o.cause ?? '').slice(0, 60),
    strategy,
    attunement,
  }
}

export function strategyText(p) {
  const st = p?.strategy
  if (!st) return ''
  const tone = { soft: '软一点', playful: '轻快一点', withdrawn: '收着一点', sharp: '冲一点', neutral: '' }[st.tone] || ''
  const len = { short: '短一点', normal: '', long: '可以多说几句' }[st.length] || ''
  const init = { low: '别主动延展', normal: '', high: '可以主动接话' }[st.initiative] || ''
  const bits = [tone, len, init, ...(st.do ?? []), ...(st.avoid ?? []).map((x) => `别${x}`)].filter(Boolean)
  return bits.length ? `【这轮表达】${bits.join('；').slice(0, 120)}` : ''
}

export async function appraiseByLlm({ ctx, text, recent = [], timeoutMs = 8000, log = null } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return null
  let llm = null
  try { llm = ctx?.get?.('llm') ?? ctx?.llm ?? null } catch { llm = null }
  if (!llm || typeof llm.prepareCall !== 'function') return null
  let route = null
  try { route = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? null } catch { route = null }
  if (!route?.provider || !route?.model) return null
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort(new Error('appraisal-timeout')) } catch {} }, Math.max(2000, Number(timeoutMs) || 8000))
  try {
    const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: 260 }, controller.signal)
    const input = recent.length ? `最近几轮：\n${recent.slice(-4).join('\n')}\n\n主人这句：${body}` : `主人这句：${body}`
    const messages = [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: input }], source: { kind: 'persona-appraisal' } }]
    let out = ''
    for await (const chunk of call.stream({ ...call.config, messages, system: APPRAISAL_SYSTEM_PROMPT, purpose: 'persona-appraisal', signal: controller.signal })) {
      if (chunk?.type === 'text-delta') out += String(chunk.text ?? '')
      if (out.length > 4000) break
    }
    const p = parseAppraisal(out)
    if (!p.ok) { try { log?.warn?.(`[persona] appraisal 解析失败：${p.reason}`) } catch {} ; return null }
    return p
  } catch (e) {
    try { log?.warn?.(`[persona] appraisal 失败：${e?.message ?? e}`) } catch {}
    return null
  } finally { clearTimeout(timer) }
}
