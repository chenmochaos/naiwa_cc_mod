/**
 * 场合判定 + 安全策略的**纯逻辑层**：只决定「现在算什么场合、该不该开口」，不执行。
 *
 * 和 audio.ts 一个范式 —— 这里不碰 `$`，所以 `claude plugin test` 里可以直接
 * 把判定表当数据测（见 register.test.ts 的 T26）。
 *
 * 一条硬约束写在文件深处，改之前先看 `shouldSpeak`：**urgent 场合一次都不读时钟**。
 * 原因是 register.test.ts 的 T1/T2/T4/T5（危险命令、密钥拦截）根本没搭
 * `mock.clock`，拦截路径一读 `$.clock.now()` 就是 "no implementation"，
 * 四条测试当场变红。拦截必须无条件开口，本来也不该被冷却压住。
 */

import type { Mood } from '../types'

/**
 * 一个「值得反应」的场合。共 14 个。
 *
 * 刻意**不含**「编辑成功」「普通命令成功」—— 那些场合奶蛙不开口，只记数。
 * 说话太密本身就是上一版被投诉的原因之一。
 */
export type Occasion =
  | 'greeting'
  | 'frustrated'
  | 'banter'
  | 'milestone'
  | 'prompt'
  | 'turnfail'
  | 'blocked'
  | 'secret'
  | 'fail'
  | 'green'
  | 'greenlight'
  | 'recovered'
  | 'manual'
  | 'offwork'

/**
 * - `urgent` 无条件开口、**不读时钟**（拦截必须立刻反应）
 * - `notable` 1.5s 冷却（失败、翻盘这类必要反应，不该被 8s 压掉）
 * - `normal` 8s 冷却（寒暄、普通提问）
 * - `bypass` 不设冷却（下班彩蛋一天一次，自己带守卫）
 */
export type Priority = 'urgent' | 'notable' | 'normal' | 'bypass'

/**
 * 场合 → 表情。**生气和失落分工明确，别混**：
 *  - `angry` 对着「危险动作」—— 拦下的命令、要动密钥的手。它瞪的是那件事。
 *  - `sad` 对着「不顺」—— 你说丧气话、命令/测试挂了。它陪的是你。
 * 把失败画成生气，读起来就成了「奶蛙在怪你」，正好反了。
 */
export const MOOD_OF: Record<Occasion, Mood> = {
  greeting: 'calm',
  frustrated: 'sad',
  banter: 'laugh',
  milestone: 'laugh',
  prompt: 'calm',
  turnfail: 'angry',
  blocked: 'angry',
  secret: 'angry',
  fail: 'sad',
  green: 'laugh',
  greenlight: 'laugh',
  recovered: 'laugh',
  manual: 'laugh',
  offwork: 'laugh',
}

export const PRIORITY_OF: Record<Occasion, Priority> = {
  greeting: 'normal',
  frustrated: 'notable',
  banter: 'notable',
  milestone: 'normal',
  prompt: 'normal',
  turnfail: 'notable',
  blocked: 'urgent',
  secret: 'urgent',
  fail: 'notable',
  green: 'notable',
  greenlight: 'notable',
  recovered: 'notable',
  manual: 'bypass',
  offwork: 'bypass',
}

export const COOLDOWN_MS: Record<Priority, number> = {
  urgent: 0,
  notable: 1_500,
  normal: 8_000,
  bypass: 0,
}

/**
 * 冷却到了吗。纯函数 —— `now` 由调用方传，因为 urgent 场合根本不该去取它。
 */
export function shouldSpeak(priority: Priority, lastAt: number, now: number): boolean {
  const gap = COOLDOWN_MS[priority]
  if (gap === 0) return true
  return now - lastAt >= gap
}

// ------------------------------------------------------------------ 安全正则

/**
 * 破坏性命令。命中就 deny，不放行。
 * 这条规则和 Minus 自己的红线对齐：删文件、动 git 历史、碰密钥，都要先停下来。
 */
export const DANGER = new RegExp(
  [
    String.raw`\brm\s+(?:-{1,2}[a-zA-Z]+\s+)*-{1,2}[a-zA-Z]*[rf]`,
    String.raw`\bgit\s+push\b[^|;&]*--force`,
    String.raw`\bgit\s+push\b[^|;&]*\s-f(\s|$)`,
    String.raw`\bgit\s+reset\s+--hard`,
    String.raw`\bgit\s+clean\s+-{1,2}[a-zA-Z]*[fd]`,
    String.raw`\bgit\s+branch\s+-D\b`,
    String.raw`\bmkfs(\.\w+)?\b`,
    String.raw`\bdd\b[^|;&]*\bof=/dev/`,
    String.raw`>\s*/dev/[sh]d[a-z]`,
    String.raw`:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:`,
    String.raw`\bchmod\s+-R\s+777\s+/`,
  ].join('|'),
  'i',
)

/** 密钥与凭据文件。命中就 deny —— 这些不进代码、不进 commit。 */
export const PROTECTED = new RegExp(
  [
    String.raw`(^|/)\.env(?!\.(example|sample|template|dist))(\.[\w-]+)?$`,
    String.raw`(^|/)\.ssh/`,
    String.raw`(^|/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)`,
    String.raw`\.pem$`,
    String.raw`(^|/)\.netrc$`,
    String.raw`(^|/)credentials(\.json)?$`,
  ].join('|'),
  'i',
)

/** 看着像「跑验证」的命令，成功时值得笑一声。 */
export const VERIFY = /\b(test|tests|pytest|vitest|jest|tsc|typecheck|lint|build|make|cargo|gradle|mvn)\b/i

/**
 * 比 VERIFY 窄得多的**测试运行器**正则。只有它才够格触发自动彩蛋 ——
 * `build` / `lint` 通过只是「顺」，跑完一整套测试全绿才算高光。
 */
export const SUITE =
  /\b(vitest|jest|pytest|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|go\s+test|cargo\s+test|ctest|gradle\s+test|mvn\s+test)\b/i

export function describeDanger(command: string): string {
  if (/\brm\b/i.test(command)) return '它会删文件'
  if (/reset\s+--hard/i.test(command)) return '它会丢掉没提交的改动'
  if (/--force|\s-f(\s|$)/.test(command)) return '它可能强推、覆盖远端历史'
  if (/\bmkfs|\bdd\b/i.test(command)) return '它会往裸设备上写'
  if (/chmod\s+-R\s+777/i.test(command)) return '它会把权限整个放开'
  return '它是不可逆的破坏性操作'
}

/** 命中的那一小段原文，当面板上的「判断依据」用。 */
export function dangerHit(command: string): string {
  const matched = DANGER.exec(command)
  return matched === null ? '' : matched[0].trim().slice(0, 16)
}

/** 文件路径的末段。判断依据显示 `.env` 比显示整条绝对路径好读。 */
export function basename(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? path : path.slice(at + 1)
}

// -------------------------------------------------------------- 你的话 → 场合

const NEGATIVE =
  /烦|崩了|又错|报错|失败|不行|救命|破防|麻了|寄了|难受|头疼|头痛|唉|为什么.*不|\bbugs?\b|wtf/i
const MILESTONE = /上线|发版|发布|做完了|写完了|收工|搞定|完成|合并|\b(merge|done|ship)\b/i
const BANTER = /哈哈|笑死|太强|牛|成了|跑通了|耶|嘿嘿|好耶|xswl|\b(haha|lol)\b|😂|🎉/i

const FILE_HIT = /[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|md|json|toml|ya?ml|css|html|sh)/
const QUOTED = /[「『"']([^」』"']{1,12})[」』"']/
const KEYWORD_HITS = ['bug', '报错', '测试', '部署', '重构', '接口'] as const

/** 槽位最多这么长。模板长度是按这个上限校准的，改大会顶破 30 字。 */
export const HIT_MAX = 10

/**
 * 从你的原话里抠一个词出来填进台词槽位。
 *
 * 这是「台词跟你说的内容相关」最直接的来源：哪怕 LLM 那一层不可用，
 * 本地模板也带着你刚说过的词。抠不到就返回空串，模板会退化成「这个」。
 */
export function hitOf(text: string): string {
  const file = FILE_HIT.exec(text)
  if (file !== null) return file[0].slice(0, HIT_MAX)
  const quoted = QUOTED.exec(text)
  if (quoted !== null) return quoted[1].slice(0, HIT_MAX)
  const lower = text.toLowerCase()
  for (const word of KEYWORD_HITS) {
    if (lower.includes(word)) return word
  }
  return ''
}

/**
 * 你刚说的这句话算什么场合。判断顺序即优先级：
 * 负面压倒一切（你烦的时候不需要玩梗），其次是里程碑，最后才是玩梗。
 */
export function readPrompt(text: string): Occasion {
  if (NEGATIVE.test(text)) return 'frustrated'
  if (MILESTONE.test(text)) return 'milestone'
  if (BANTER.test(text)) return 'banter'
  return 'prompt'
}

// ------------------------------------------------------------------ 场合判定

/**
 * 一个事件里所有跟「该不该开口」有关的信息。
 *
 * 刻意只带纯数据、不带 `$` 也不带原始事件对象 —— 这样 `occasionOf` 可以在
 * 没有引擎的情况下把整张判定表跑一遍。
 */
export type Signal =
  | { kind: 'prompt'; text: string }
  | { kind: 'turn'; reason: string }
  | { kind: 'bashCall'; command: string }
  | { kind: 'bashResult'; command: string; isError: boolean; text: string; failStreak: number }
  | { kind: 'writeCall'; path: string }

/**
 * `hit` 填进台词的槽位，`why` 是面板上那句判断依据 —— 两者刻意分开：
 * 拦截命令的槽位没东西可填（模板里没有 `{hit}`），但依据必须显示命中的原文。
 */
export type Verdict = { occasion: Occasion; hit: string; why: string }

const NOTHING: { hit: string; why: string } = { hit: '', why: '' }

/** 命令跑完算不算「绿」。保守优先：拿不准就当没绿。 */
function isGreen(text: string): boolean {
  return !/Exit code [1-9]\d*/.test(text) && !/[1-9]\d* failed/.test(text)
}

/**
 * 场合判定总表。返回 `null` = 这个事件不值得开口，只记数。
 *
 * 拦截（`blocked` / `secret`）也走这张表，让 register.tsx 只问一次
 * 「现在算什么场合」，然后拿它的结果同时决定 deny 和表情。
 */
export function occasionOf(signal: Signal): Verdict | null {
  if (signal.kind === 'prompt') {
    return {
      occasion: readPrompt(signal.text),
      hit: hitOf(signal.text),
      why: NOTHING.why,
    }
  }

  if (signal.kind === 'turn') {
    return signal.reason === 'error' || signal.reason === 'aborted'
      ? { occasion: 'turnfail', ...NOTHING }
      : null
  }

  if (signal.kind === 'bashCall') {
    return DANGER.test(signal.command)
      ? { occasion: 'blocked', hit: '', why: dangerHit(signal.command) }
      : null
  }

  if (signal.kind === 'writeCall') {
    return PROTECTED.test(signal.path)
      ? { occasion: 'secret', hit: '', why: basename(signal.path) }
      : null
  }

  // bashResult
  if (signal.isError) return { occasion: 'fail', ...NOTHING }

  // 测试运行器单独判，**不能**让它掉进下面的 VERIFY —— `vitest` 也在 VERIFY 里，
  // 那样一次「跑完了但有红的」会被当成验证通过，是错得最难发现的一种。
  if (SUITE.test(signal.command)) {
    if (!isGreen(signal.text)) return { occasion: 'fail', ...NOTHING }
    // 连挂两次以上之后跑通才算翻盘；否则只是普通的「全绿」。
    return signal.failStreak >= 2
      ? { occasion: 'recovered', hit: '', why: `连挂 ${signal.failStreak} 次后跑通` }
      : { occasion: 'greenlight', ...NOTHING }
  }

  if (VERIFY.test(signal.command)) return { occasion: 'green', ...NOTHING }
  return null
}
