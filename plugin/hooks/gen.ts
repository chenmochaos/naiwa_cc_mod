/**
 * LLM 台词生成的**纯策略层**：只构造请求、只净化回复，不执行。
 *
 * 和 audio.ts / signals.ts 一个范式，理由也一样：`$` 只能传进本文件内声明的函数，
 * 不能跨 import。所以 `$.model.complete` / `$.session.model()` 这两个调用字面写在
 * register.tsx，这里只出「该请求什么」和「回复能不能用」。
 *
 * 实测事实（2026-10-04，本机 DeepSeek 网关，见 /tmp/naiwa-spike.json）：
 *  1. `$.model.complete` 在网关上是通的，正常返回 isAnswered: true。
 *  2. **`maxTokens` 不生效** —— 传 8，回来 output_tokens 84（reasoning 也算进去）。
 *     所以「靠 maxTokens 从物理上强制短」是假的，**`sanitize` 的长度检查是唯一的
 *     brevity 闸门**，不是锦上添花。别把这一段删了。
 *  3. 一次调用 1.1–5.6 秒。所以永远是「先本地渲染、后异步补刀」，
 *     LLM 延迟绝不落在热路径上。
 *  4. 字面量 `'haiku'` 没有被 allowlist 拒绝。仍然传 `$.session.model()`，
 *     但理由换成「跟你实际在用的模型保持一致」，不是「否则会被拒」。
 */

import type { Occasion } from './signals'

/** 只有这几个场合值得花一次调用。其余全部走本地模板。 */
export const MODEL_WORTHY: readonly Occasion[] = ['greeting', 'frustrated', 'banter', 'milestone']

export const GEN_MAX_PER_SESSION = 3
export const GEN_MIN_GAP_MS = 15_000

/** 一次调用要等多久。实测最慢 5.6s，给到 8s —— 超时会 resolve 成 aborted，不 reject。 */
export const GEN_TIMEOUT_MS = 8_000

/** 这个值网关不认（见文件头第 2 条），留着只是表达意图。 */
export const GEN_MAX_TOKENS = 48

/** 一行台词的长度上限。超了直接丢，退回本地模板。 */
export const MAX_LINE = 30

/** 你原话送进提示词时的截断长度。 */
const USER_TEXT_MAX = 200

export const GEN_SYSTEM = [
  '你叫「奶蛙」，是一只陪人写代码的青蛙。说话可爱里掺着鬼畜，招牌笑声是「齁齁齁」。',
  '',
  '现在只需要你说**一句话**：',
  '- 只输出那一句话本身，不要引号、不要换行、不要 markdown、不要 emoji；',
  '- 不超过 20 个汉字；',
  '- 内容要贴着我刚说的话，别自说自话；',
  '- **绝对不要给技术判断、不要诊断报错、不要给修复建议、不要复述命令或报错原文。**',
  '  你只负责情绪，技术上的事交给 Claude。',
].join('\n')

export type GenRequest = {
  model: string
  system: string
  prompt: string
  maxTokens: number
  effort: 'low'
  timeoutMs: number
}

export type GenContext = {
  occasion: Occasion
  /** 从用户原话里抠出来的词，可能为空。 */
  hit: string
  /** 用户的原话。greeting 时为空串。 */
  userText: string
}

/** 每种场合该怎么问。问句本身也要求「贴着我刚说的话」。 */
function askOf(context: GenContext): string {
  const said = context.userText.replace(/\s+/g, ' ').trim().slice(0, USER_TEXT_MAX)
  switch (context.occasion) {
    case 'greeting':
      return '用户刚打开一个写代码的会话。用奶蛙的语气打个招呼，一句。'
    case 'frustrated':
      return `用户刚说：「${said}」。他听着不太顺，安慰一句，一句。`
    case 'banter':
      return `用户刚说：「${said}」。他在乐，跟着乐一句，一句。`
    case 'milestone':
      return `用户刚说：「${said}」。他做成了件事，庆贺一句，一句。`
    default:
      return `用户刚说：「${said}」。用奶蛙的语气接一句。`
  }
}

export function buildRequest(context: GenContext, model: string): GenRequest {
  return {
    model,
    system: GEN_SYSTEM,
    prompt: askOf(context),
    maxTokens: GEN_MAX_TOKENS,
    effort: 'low',
    timeoutMs: GEN_TIMEOUT_MS,
  }
}

/**
 * 出现这些就整句丢掉。宁可少说，不说坏话 ——
 * 奶蛙是个搞笑角色，一旦它开始「建议」「试试」「报错」，
 * 就有把猜测讲成技术结论的风险。
 */
const BANNED = /```|`|\brm\b|Exit code|\/dev\/|\.env|\.pem|报错|建议|应该|试试|\//

/** 表情符号。清掉而不是丢弃 —— 多个 emoji 不算「说错话」。 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu

/** markdown 装饰字符。 */
const MARK = /[*_#>~|]/g

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
  ["'", "'"],
]

function unwrapQuotes(text: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length).trim()
    }
  }
  return text
}

/**
 * 最后一道闸。任何可疑一律返回 `null`，调用方原样保留已经在屏幕上的本地台词。
 *
 * 顺序有讲究：**先查禁用词，再剥装饰** —— 反过来的话 ``` 会被剥成空串，
 * 于是「模型输出了代码块」变成了「模型什么都没说」，看起来像降级成功。
 */
export function sanitize(raw: string): string | null {
  const first = raw.split(/\r?\n/).find(line => line.trim() !== '')
  if (first === undefined || first === '') return null
  if (BANNED.test(first)) return null

  const stripped = unwrapQuotes(first.replace(EMOJI, '').replace(MARK, '').trim()).trim()
  if (stripped === '' || stripped.length > MAX_LINE) return null
  if (BANNED.test(stripped)) return null
  return stripped
}
