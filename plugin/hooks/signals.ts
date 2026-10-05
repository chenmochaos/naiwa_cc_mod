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
 *
 * **匹配的是「命令真正跑到的地方」，不是整条字符串。**
 * 老版本是一条大正则扫全文，于是 `grep -rn "rm -rf" .`、`git commit -m "fix rm -rf"`
 * 全被拦了 —— 引号里的危险字样只是文本，不是命令。误报比漏报更伤：
 * 人被打断两次就把插件关了，能不能拦反而没人知道了。
 *
 * 现在的规矩有三层：
 *   1. 引号内容整段摘出去，只在剩下的**裸文本**里认命令（`scan`）；
 *   2. 命令词必须站在**命令位** —— 开头，或 `;` `&&` `|` `(` 之后；
 *      `sudo` / `env FOO=1` / `timeout 5` 这些外壳剥掉再看（`commandWord`）；
 *   3. 引号里确实会**再跑一遍**的入口（`bash -c "..."`、`sh -c '...'`）递归进去 ——
 *      只有它们引号里的正文才是命令，别的命令的引号都只是参数。
 */

/** 命令位的分界符：这些字符一出现，后面就是另一条命令。 */
const SEPARATORS = new Set([';', '|', '&', '\n', '(', ')', '{', '}', '`'])

/** 外壳命令：剥掉它们，真正要跑的是后面的那个词。 */
const WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'builtin', 'exec', 'env', 'nohup', 'time',
  'timeout', 'nice', 'ionice', 'setsid', 'stdbuf', 'xargs',
])

/** 这些开关要吃掉后面的一个词（`sudo -u root rm -rf` 里 `root` 是值，不是命令）。 */
const TAKES_VALUE = new Set([
  '-u', '-g', '-n', '-p', '-C', '-U', '--user', '--group', '--chdir', '--adjustment',
])

/** 引号内容会被**当成命令再跑一次**的入口。不在这个表里的，引号就只是参数。 */
const REEXEC = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'eval'])

/** 一条命令被切开后的一段：`words` 是裸词，`quotes` 是这段里摘出来的引号内容。 */
type Segment = { words: string[]; quotes: string[] }

/**
 * 找引号的收尾位置，找不到返回 -1。
 *
 * 双引号里 `\"` 是转义、不算收尾 —— 这条必须自己走一遍，`indexOf` 会把
 * `echo "note: \"; rm -rf /tmp/y"` 从 `\"` 处截断，后半句漏成裸文本，于是假报。
 * 单引号里反斜杠就是普通字符，不做转义。
 */
function closeQuote(command: string, at: number, quote: string): number {
  for (let i = at + 1; i < command.length; i += 1) {
    const ch = command[i] as string
    if (ch === '\\' && quote === '"') {
      i += 1
      continue
    }
    if (ch === quote) return i
  }
  return -1
}

/**
 * 切分命令。引号（含转义）一律抹成空白 —— 它们不参与命令判定；
 * `flat` 是抹掉引号后的全文，留给重定向、fork 炸弹这种不在命令位的模式用。
 */
function scan(command: string): { segments: Segment[]; flat: string } {
  const segments: Segment[] = []
  let words: string[] = []
  let quotes: string[] = []
  let word = ''
  let flat = ''

  const endWord = (): void => {
    if (word === '') return
    // `find ... -exec rm -rf {} +` —— -exec 后面跟的也是一条要跑的命令，在这里断句
    if (word === '-exec' || word === '-execdir') {
      word = ''
      endSegment()
      return
    }
    words.push(word)
    word = ''
  }
  const endSegment = (): void => {
    endWord()
    if (words.length > 0 || quotes.length > 0) segments.push({ words, quotes })
    words = []
    quotes = []
  }

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string
    // 转义掉的字符不是你敲的命令（`find . \( -name x \)` 这类）
    if (ch === '\\') {
      i += 1
      flat += ' '
      continue
    }
    if (ch === "'" || ch === '"') {
      const close = closeQuote(command, i, ch)
      const stop = close === -1 ? command.length : close
      endWord()
      quotes.push(command.slice(i + 1, stop))
      flat += ' '
      i = stop
      continue
    }
    flat += ch
    if (SEPARATORS.has(ch)) {
      endSegment()
      continue
    }
    if (/\s/.test(ch)) {
      endWord()
      continue
    }
    word += ch
  }
  endSegment()
  return { segments, flat }
}

/**
 * `<<'EOF'` 的正文归谁吃 —— 返回 `<<` **前面**那条命令的命令词。
 * `sudo bash <<EOF` 要认出 `bash`，`git commit -F - <<'MSG'` 要认出 `git`，
 * 所以跳过赋值、外壳和开关，取第一个实词（不是 `commandWord` 那种「最后一个」，
 * `sh - <<EOF` 的 `-` 会把 commandWord 卡住）。
 */
function heredocOwner(before: string): string {
  const segments = scan(before).segments
  const last = segments[segments.length - 1]
  if (last === undefined) return ''
  for (const word of last.words) {
    if (WRAPPERS.has(word)) continue
    if (word.startsWith('-')) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    return word.replace(/^.*\//, '')
  }
  return ''
}

/**
 * heredoc 的正文是**喂给命令的数据**，和引号同理 —— 不是命令。
 * 踩过：v0.3.1 的提交信息正文里有一行以 `rm -rf` 开头，插件把自己的
 * `git commit -F - <<'MSG'` 拦了。提交信息里提危险命令是最正常不过的事。
 *
 * 正文抹成空白（保留换行，断句照旧）；只有喂给 `bash` / `sh` 这类
 * **会把正文当代码跑**的壳，才把正文单独收进 `bodies` 送进 `findDanger`。
 * 找不到收尾行（写错了、或者 `<<` 只是字符串里的一段）就**什么都不抹** ——
 * 宁可多扫一遍，也不要因为一个没配对的 `<<` 把后面半条命令藏起来。
 */
function blankHeredocs(command: string, bodies: string[]): string {
  const out = command.split('')
  const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
  let m: RegExpExecArray | null
  while ((m = opener.exec(command)) !== null) {
    const marker = m[2] as string
    const nl = command.indexOf('\n', m.index)
    if (nl === -1) continue
    const start = nl + 1
    let line = start
    let end = -1
    while (line <= command.length) {
      const stop = command.indexOf('\n', line)
      const text = command.slice(line, stop === -1 ? command.length : stop).trim()
      if (text === marker) {
        end = line
        break
      }
      if (stop === -1) break
      line = stop + 1
    }
    if (end === -1) continue
    if (REEXEC.has(heredocOwner(command.slice(0, m.index)))) {
      bodies.push(command.slice(start, end))
    }
    for (let k = start; k < end; k += 1) if (out[k] !== '\n') out[k] = ' '
    opener.lastIndex = end
  }
  return out.join('')
}

/** 剥掉外壳之后，这一段真正要跑的命令词。剥不出来就返回 null。 */
function commandWord(words: string[]): { verb: string; args: string[] } | null {
  let i = 0
  while (i < words.length) {
    const word = words[i] as string
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i += 1 // `env FOO=1 cmd` 里的赋值
      continue
    }
    if (WRAPPERS.has(word)) {
      i += 1
      continue
    }
    if (TAKES_VALUE.has(word)) {
      i += 2
      continue
    }
    if (word.startsWith('-') || /^\d+$/.test(word)) {
      i += 1 // 外壳自己的开关，或 `timeout 5` 里的秒数
      continue
    }
    break
  }
  if (i >= words.length) return null
  return { verb: words[i] as string, args: words.slice(i + 1) }
}

/**
 * `rm` 只有**递归**才算危险：`-r` `-R` `-rf` `-fr` `-irf` `--recursive` 要拦，
 * `-f` / `--force` / `-v` 不拦。
 *
 * `rm -f 单个文件` 是日常动作，拦它等于把插件变成绊脚石。之前那版是
 * `-{1,2}[A-Za-z]*(r|R|f)`，**按字母出现的位置匹配** —— 于是 `--verbose`、`--force`、
 * `--interactive` 里只要有个 r 或 f 就中招。踩过：插件把自己的 `rm -f /tmp/x` 拦了。
 */
const RM_RECURSIVE = /^(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)$/

/**
 * `rm` 还必须是「**整片**」的目标才算危险。递归删自己项目里的某个目录
 * （`rm -rf build/`、`rm -rf node_modules`、`rm -rf /tmp/x`）是每天的活，
 * 拦它不是保护，是绊脚石 —— 人被打断两次就把插件关了。
 *
 * 算「整片」的：根、家目录、当前/上级目录、通配「这里全部」。
 */
const RM_WHOLE_TREE = [
  /^\/+$/, // /  ///
  /^\/\*+$/, // /*
  /^~\/?$/, // ~  ~/
  /^~\/\*+$/, // ~/*
  /^\$\{?HOME\}?\/?$/, // $HOME  ${HOME}
  /^\$\{?PWD\}?\/?$/, // $PWD  ${PWD}
  /^\.\.?\/?$/, // .  ..  ./  ../
  /^(?:\.\.?\/)+$/, // ../  ../../
  /^\*+$/, // *
  /^\.\/\*+$/, // ./*
]

/**
 * 系统目录**本身**、以及它们的下一层 —— `/home/minus` 是「一个人的整个家目录」，
 * 而 `/home/minus/proj/target` 只是他的构建产物，两码事。
 */
const RM_SYSTEM =
  /^\/(?:etc|usr|var|bin|sbin|lib|lib64|boot|dev|proc|sys|run|home|root|opt|srv)(?:\/[^/]+)?\/?$/

/** `git` 后面要先吃掉「带值的全局开关」，剩下的第一个词才是子命令。 */
const GIT_GLOBAL = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** 这一段命令危险吗。危险就返回命中的那个片段（面板的「判断依据」用它）。 */
function segmentDanger(words: string[]): string | null {
  const head = commandWord(words)
  if (head === null) return null
  const verb = head.verb.replace(/^.*\//, '') // /bin/rm 也算 rm
  const args = head.args

  if (verb === 'rm') {
    const flag = args.find(w => RM_RECURSIVE.test(w))
    if (flag === undefined) return null
    const targets = args.filter(w => w.charAt(0) !== '-')
    // 一个目标都没有 = 看不见它要删什么（`xargs rm -rf` 把文件名喂进来、find 的 `{}`）。
    // 看得见才判得了，看不见就不放行。
    if (targets.length === 0) return `rm ${flag}`
    const hit = targets.find(
      t => t === '{}' || RM_SYSTEM.test(t) || RM_WHOLE_TREE.some(re => re.test(t)),
    )
    return hit === undefined ? null : `rm ${flag} ${hit}`
  }

  if (verb === 'git') {
    const rest: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      if (GIT_GLOBAL.has(args[i] as string)) {
        i += 1
        continue
      }
      rest.push(args[i] as string)
    }
    const sub = rest[0] ?? ''
    if (sub === 'push' && rest.some(w => /^--force/.test(w) || /^-[A-Za-z]*f/.test(w))) {
      return 'git push --force'
    }
    if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard'
    if (sub === 'clean' && rest.some(w => /^-[A-Za-z]*[fd]/.test(w))) return 'git clean -fd'
    if (sub === 'branch' && rest.some(w => /^-[A-Za-z]*D/.test(w))) return 'git branch -D'
    return null
  }

  if (/^mkfs(\.[\w.]+)?$/.test(verb)) return verb
  if (verb === 'dd' && args.some(w => w.startsWith('of=/dev/'))) return 'dd of=/dev/*'
  if (
    verb === 'chmod' &&
    args.some(w => w === '-R' || w === '--recursive') &&
    args.includes('777') &&
    args.some(w => w.startsWith('/'))
  ) {
    return 'chmod -R 777 /'
  }
  return null
}

/** 往裸设备上写。重定向可以出现在任何位置，所以不在命令位判定里，单独扫。 */
const DEVICE_WRITE = />>?\s*\/dev\/[sh]d[a-z]/

/** fork 炸弹：`:(){ :|:& };:`。特征串正常人打不出来，所以误报可以忽略。 */
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*[:|&]/

/**
 * 这条命令里有没有真危险的动作。返回命中的片段，没有就返回 null。
 *
 * `depth` 是 `bash -c "..."` 这种「引号里再跑一遍」的层数，防病态嵌套。
 */
export function findDanger(command: string, depth = 0): string | null {
  const bodies: string[] = []
  const { segments, flat } = scan(blankHeredocs(command, bodies))

  if (depth < 3) {
    for (const body of bodies) {
      const nested = findDanger(body, depth + 1)
      if (nested !== null) return nested
    }
  }

  for (const segment of segments) {
    const hit = segmentDanger(segment.words)
    if (hit !== null) return hit
    if (depth >= 3) continue

    const head = commandWord(segment.words)
    if (head === null) continue
    const verb = head.verb.replace(/^.*\//, '')
    if (!REEXEC.has(verb)) continue
    // 壳要带 `-c` 才会把参数当命令跑；`eval` 不用
    if (verb !== 'eval' && !head.args.some(w => /^-[A-Za-z]*c/.test(w))) continue

    for (const inner of segment.quotes) {
      const nested = findDanger(inner, depth + 1)
      if (nested !== null) return nested
    }
  }

  if (DEVICE_WRITE.test(flat)) return '> /dev/sd*'
  if (FORK_BOMB.test(flat)) return 'fork 炸弹'
  return null
}

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

/** deny 那句话里的「为什么」。依据取自 `findDanger` 命中的片段，不重扫一遍原文。 */
export function describeDanger(command: string): string {
  const hit = findDanger(command)
  if (hit === null) return '它是不可逆的破坏性操作'
  // 能走到这儿的 rm 一定是「递归 + 整片目标」，说「删文件」太轻了
  if (hit.startsWith('rm')) return '它会连根删掉一整片'
  if (hit.includes('reset')) return '它会丢掉没提交的改动'
  if (hit.includes('clean')) return '它会删掉没被跟踪的文件'
  if (hit.includes('push') || hit.includes('branch')) return '它可能强推、覆盖远端历史'
  if (hit.includes('fork')) return '它会把你的进程叉到天上去'
  if (hit.includes('mkfs') || hit.includes('dd') || hit.includes('/dev/')) return '它会往裸设备上写'
  if (hit.includes('chmod')) return '它会把权限整个放开'
  return '它是不可逆的破坏性操作'
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
    const hit = findDanger(signal.command)
    return hit === null ? null : { occasion: 'blocked', hit: '', why: hit }
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
