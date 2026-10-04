/**
 * `claude plugin test plugin/`
 *
 * 三件事必须先搞清楚，否则测试根本跑不起来：
 *
 * 1. **测试里的 `$` 只有「驱动用」的一部分**（tool/command/prompt/session/ui/…），
 *    没有 `fs`/`process`/`clock`/`store`/`state`。所以别在测试体里直接调
 *    `$.fs.exists`，只能通过插件的行为间接触发。
 * 2. **插件在 hook 里拿到的 `$` 是完整引擎**，它调的每个 `$.noun.verb` 都会
 *    变成事件，`on(...)` 注册的 hook 站在插件**下面**当实现。op 事件的 hook 是
 *    `($, e) => ({ value })`（注意第一个参数是 `$`，不是 `e`），
 *    `tool.call` 则是 `{ result }` / `{ deny }`。
 * 3. **同一个事件不能 `on` 两次**，会 "hooks module did not load"。
 *    所以 store / clock 的桩都集中在 `engine()` 里，测试不要再叠 `mock.store`。
 *
 * 好处：「插件到底做了什么」可以被完整观测 —— 尤其是它有没有偷偷调
 * `$.audio.play`（Linux 上那个是死路，见 audio.ts）。
 *
 * 面板和台词条用 `$.ui.mount` **真渲染**再断言，所以「面板上还有没有按钮」
 * 「心情和判断依据显不显示」都是真断言，不是对着源码猜的。
 */

import type { Engine, ModelCompleteRequest, ModelCompleteResult, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { MAX_LINE, sanitize } from './gen'
import { LAUGH, LAUGH_PALETTE } from './laugh-meta'
import { TEMPLATES, renderTemplate } from './lines'
import { HIT_MAX, occasionOf, shouldSpeak } from './signals'

const CLIP = 'laugh.mp3'
const SESSION = { cwd: '/tmp', surface: 'terminal', isInteractive: false } as const

/** 一帧多少字节：每像素 1 字节，`columns × (rows × 2)` 像素。 */
const PX = LAUGH.columns * LAUGH.rows * 2

/**
 * 冒充 `laugh.bin` 的已知图案。
 *
 * 透明规则取 `(py + px) % 4 <= 1`，是为了让**三种格子都出现**（这是关键，
 * 随便挑个规则很容易退化成「只有 ▀」，那样透明路径等于没测）：
 *
 *   m = (2y + x) % 4   →  上半透明?  下半透明?  格子
 *        0                 是          是       空格
 *        1                 是          否       ▄
 *        2                 否          否       ▀
 *        3                 否          是       ▀（背景透明）
 *
 * 不透明的像素在色板下标里循环、并逐帧错开（`+ f`），好让每帧都不一样。
 */
const PATTERN = (() => {
  const b = new Uint8Array(LAUGH.frames * PX)
  for (let f = 0; f < LAUGH.frames; f += 1) {
    for (let py = 0; py < LAUGH.rows * 2; py += 1) {
      for (let px = 0; px < LAUGH.columns; px += 1) {
        const t = (py + px) % 4
        b[f * PX + py * LAUGH.columns + px] =
          t <= 1 ? 255 : (py * 3 + px + f) % LAUGH_PALETTE.length
      }
    }
  }
  return b
})()

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const ANSWER = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })

type Stubs = {
  registered: string[]
  toasts: string[]
  argv: string[][]
  audioPlays: number
  spoke: string[]
  opened: number
  closed: string[]
  blits: string[]
  /** `$.store` 的真身。断言开关有没有落盘就直接看它。 */
  store: Map<string, unknown>
  /** 每一次 `$.model.complete` 收到的请求。 */
  asks: ModelCompleteRequest[]
}

/** `engine()` 的第三参：预置 store、换模型名、控制 LLM 回复。 */
type Init = {
  stored?: Record<string, unknown>
  model?: string
  complete?: (request: ModelCompleteRequest) => Promise<ModelCompleteResult> | ModelCompleteResult
}

/**
 * 站在插件底下的「引擎」。
 * `bins` 是 `fs.exists` 报存在的可执行文件基名 —— 控制探测到 paplay 还是 spd-say。
 *
 * store 用一张内存表而不是「永远 undefined」，因为 `/naiwa` 开关的持久性
 * 只能这么测（T23/T24）。**注意仍然是只 `on` 一次** —— 同事件注册两次会把模块拒掉。
 */
function engine(on: On, bins: readonly string[] = [], init: Init = {}): Stubs {
  const store = new Map<string, unknown>(Object.entries(init.stored ?? {}))
  const s: Stubs = {
    registered: [],
    toasts: [],
    argv: [],
    audioPlays: 0,
    spoke: [],
    opened: 0,
    closed: [],
    blits: [],
    store,
    asks: [],
  }

  on('command.register', (_$, e) => {
    s.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    s.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => {
    s.opened += 1
    return { value: { isPlaced: true } as const }
  })
  on('ui.close', (_$, e) => {
    s.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.blit', (_$, e) => {
    s.blits.push(e.cells)
    return { value: {} }
  })
  on('audio.play', () => {
    s.audioPlays += 1
    return { value: undefined }
  })
  on('audio.speak', (_$, e) => {
    s.spoke.push(e.text)
    return { value: {} }
  })
  on('fs.exists', (_$, e) => ({ value: bins.some(name => e.path.endsWith(`/${name}`)) }))
  // 用已知图案而不是一片 0：全 0 的假数据会把「透明像素」这条路径整个跳过，
  // 测出来是绿的，但实际什么都没验。图案见 PATTERN 的注释。
  on('fs.read', () => ({ value: { base64: PATTERN.toBase64() } }))
  on('process.run', (_$, e) => {
    s.argv.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'Linux\n', stderr: '' } }
  })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.model', () => ({ value: init.model ?? 'test-model' }))
  on('model.complete', async (_$, e) => {
    s.asks.push(e)
    const answer = init.complete === undefined ? ANSWER('测试台词。') : await init.complete(e)
    return { value: answer }
  })

  // 插件在 prompt.submit 里 `return next(e)` —— 链子底下必须有人接，
  // 否则 "no implementation for prompt.submit"。真机上接的是引擎核心。
  //
  // 返回形状的坑：**引擎事件返回裸结果，op 事件（`$.noun.verb`）才返回 `{ value }`**。
  // `prompt.submit` / `ui.render` / `prompt.compose` / `session.start` 都是引擎事件，
  // 包一层 `{ value }` 会被判成「既没有 text 也没有 drop」然后整个跳过。
  on('prompt.submit', (_$, e) => ({ text: e.text }))

  // 同理：`line` 为空时台词条那个 hook 也 `return next(e)`。返回一棵**空的 Text**
  // 而不是占位文字，这样「台词条收起来了」的断言仍然是「渲染出来是空串」，
  // 不用去认某个魔法字符串。
  on('ui.render', () => ({ type: 'Text', props: {}, children: [] }))

  on('session.start', () => ({ cwd: '/tmp' }))
  on('prompt.compose', () => ({ sections: [] }))
  return s
}

/** `argv` 里有没有哪一段包含 `needle`。 */
function has(s: Stubs, needle: string): boolean {
  return s.argv.some(argv => argv.some(a => a.includes(needle)))
}

const COMPOSE = {
  model: 'test-model',
  promptModel: 'test-model',
  surfaces: ['terminal'] as const,
  tools: [] as readonly string[],
  outputStyle: null,
  traits: [] as readonly string[],
}

// ------------------------------------------------------------ 真渲染的观测口

/**
 * 用 `desktop` 而不是 `terminal`：桌面表面没有 `Raster`，插件会走
 * 「画个文字头像」那条分支，于是不必去校验 44×26 的像素数据 ——
 * 这里要验的是「有没有按钮、心情和依据显不显示」，不是像素。
 */
const PANE_PROPS = {
  title: '🐸 奶蛙工位',
  isFocused: false,
  bodyColumns: 46,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 26 },
  view: {},
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 1,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 1 },
  view: {},
}

async function withMount(
  $: Engine,
  component: 'Pane' | 'AbovePrompt',
  read: (ui: Awaited<ReturnType<Engine['ui']['mount']>>) => Promise<string>,
): Promise<string> {
  const ui = await $.ui.mount({
    plugin: 'naiwa',
    surface: 'desktop',
    component,
    requestId: component === 'Pane' ? 'naiwa' : undefined,
    props: component === 'Pane' ? PANE_PROPS : BAND_PROPS,
  })
  try {
    return await read(ui as never)
  } finally {
    await ui.unmount()
  }
}

/** 面板上所有文字拼起来。 */
function paneText($: Engine): Promise<string> {
  return withMount($, 'Pane', async ui => {
    const texts = await ui.findAll({ type: 'Text' })
    return texts.map(t => t.text).join('\n')
  })
}

/** 台词条上那句话。空串 = 奶蛙没开口。 */
function bandText($: Engine): Promise<string> {
  return withMount($, 'AbovePrompt', async ui => {
    const texts = await ui.findAll({ type: 'Text' })
    return texts.map(t => t.text).join('\n')
  })
}

/**
 * 让插件开一次口（也就是让它落一条台词），并把时钟推过所有节流。
 *
 * 推 16 秒而不是 9 秒：开场那句寒暄也在 `MODEL_WORTHY` 里，会先花掉一次 LLM 调用
 * 并记下时间。只推 9 秒的话，接下来的第一句真实台词会撞上 `GEN_MIN_GAP_MS`（15s）
 * 的节流，`generate` 直接返回 —— 测出来是「LLM 这层坏了」，其实是节流在正常工作。
 */
async function warmUp($: Engine, clock: { advance: (ms: number) => Promise<void> }): Promise<void> {
  await $.session.start(SESSION)
  await clock.advance(16_000)
}

// ------------------------------------------------------------- 危险命令拦截

test('拦下 rm -rf，且完全不把命令交给引擎', async ($, on) => {
  let reached = false
  on('tool.call', { tool: 'Bash' }, () => {
    reached = true
    return { result: { stdout: '', stderr: '' } }
  })

  const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })

  expect(ran.deny).toBeDefined()
  expect(reached).toBe(false)
})

test('拦下强推 / 硬重置 / 裸设备写入 / fork 炸弹', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' } }))
  for (const command of [
    'git push origin main --force',
    'git push -f',
    'git reset --hard HEAD~3',
    'git clean -fd',
    'git branch -D feature',
    'dd if=/dev/zero of=/dev/sda',
    'chmod -R 777 /',
    ':(){ :|:& };:',
  ]) {
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect([command, ran.deny !== undefined]).toEqual([command, true])
  }
})

test('普通命令照原样放行', async ($, on) => {
  let seen = ''
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen = String(e.command)
    return { result: { stdout: 'ok', stderr: '' } }
  })

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls -la' })

  expect(ran.deny).toBeUndefined()
  expect(seen).toBe('ls -la')
})

// ------------------------------------------------------------------ 密钥保护

test('密钥文件不让 Edit / Write 碰', async ($, on) => {
  let reached = false
  on('tool.call', { tool: 'Edit' }, () => {
    reached = true
    return { result: {} }
  })
  on('tool.call', { tool: 'Write' }, () => {
    reached = true
    return { result: {} }
  })

  for (const file_path of [
    '/home/minus/.claude-mem/.env',
    '/home/minus/.ssh/config',
    'server/id_ed25519',
    'deploy/cert.pem',
    'aws/credentials',
  ]) {
    const edited = await $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
    expect([file_path, edited.deny !== undefined]).toEqual([file_path, true])
    const written = await $.tool.call({ tool: 'Write', file_path, content: 'x' })
    expect([file_path, written.deny !== undefined]).toEqual([file_path, true])
  }
  expect(reached).toBe(false)
})

test('.env.example 不是密钥文件，放行', async ($, on) => {
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }))
  const ran = await $.tool.call({
    tool: 'Edit',
    file_path: 'deploy/.env.example',
    old_string: 'a',
    new_string: 'b',
  })
  expect(ran.deny).toBeUndefined()
})

// -------------------------------------------------------------- system prompt

test('口吻默认关；/naiwa-talk 之后才注入 naiwa:dialect', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)

  const before = await $.prompt.compose(COMPOSE)
  expect(before.sections.some(s => s.id === 'naiwa:dialect')).toBe(false)

  await $.command.run({ command: 'naiwa-talk' })

  const section = (await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'naiwa:dialect')
  expect(section).toBeDefined()
  expect(section?.scope).toBe('session')
  // 纪律那句必须跟着一起进去：玩梗不能牺牲正确性
  expect(section?.text).toContain('代码、命令、文件名和技术结论必须准确')
})

test('session.start 注册三个命令', async ($, on) => {
  const s = engine(on)
  await $.session.start(SESSION)
  expect(s.registered).toEqual(['naiwa', 'naiwa-laugh', 'naiwa-talk'])
})

// -------------------------------------------------------------------- 音效

test('Linux + clip：走 paplay 放原声，绝不碰 $.audio.play', async ($, on) => {
  const s = engine(on, ['paplay'])
  await $.session.start(SESSION)
  await $.command.run({ command: 'naiwa-laugh' })

  expect(has(s, 'paplay')).toBe(true)
  expect(has(s, CLIP)).toBe(true)
  // 这条是核心：Linux 上 $.audio.play 什么都不播，一次都不能调
  expect(s.audioPlays).toBe(0)
})

test('audio=off：一声不响', { options: { audio: 'off' } }, async ($, on) => {
  const s = engine(on, ['paplay'])
  await $.session.start(SESSION)
  await $.command.run({ command: 'naiwa-laugh' })

  expect(s.audioPlays).toBe(0)
  expect(has(s, CLIP)).toBe(false)
})

test('Linux 上没播放器时退回 TTS，不静默失败', async ($, on) => {
  const s = engine(on, ['spd-say'])
  await $.session.start(SESSION)
  await $.command.run({ command: 'naiwa-laugh' })

  expect(has(s, 'spd-say')).toBe(true)
  expect(has(s, CLIP)).toBe(false)
  expect(s.audioPlays).toBe(0)
})

// ------------------------------------------------------------------ 动画驱动

test('大笑动画按 10fps 逐帧 blit，播完自停', async ($, on) => {
  const s = engine(on, ['paplay'])
  const clock = mock.clock(on, { now: 0 })

  await $.session.start(SESSION)
  await $.command.run({ command: 'naiwa-laugh' })
  await clock.settle()

  expect(s.opened).toBe(1)

  // 一秒 → 10 帧左右
  await clock.advance(1050)
  await clock.settle()
  expect(s.blits.length).toBeGreaterThanOrEqual(9)
  expect(s.blits.length).toBeLessThanOrEqual(11)

  // 走完全程
  await clock.advance(12_000)
  await clock.settle()
  expect(s.blits.length).toBe(LAUGH.frames)

  // 播完自停：再走 5 秒不该多出 blit（定时器必须被 cancel）
  await clock.advance(5_000)
  await clock.settle()
  expect(s.blits.length).toBe(LAUGH.frames)
})

/**
 * Raster 编码是这里最容易错、错了又最难用肉眼定位的一段：步长差一个、
 * 大小端搞反、调色板查错位、透明像素当成了色板第 0 号 —— 屏幕上是整张脸糊掉，
 * 但你不知道是哪一步。所以把 blit 出去的 base64 反解回来，逐格对期望值。
 */
test('blit 出去的 cells 精确还原帧数据（含透明像素）', async ($, on) => {
  const s = engine(on, ['paplay'])
  const clock = mock.clock(on, { now: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'naiwa-laugh' })
  await clock.advance(1_200)
  await clock.settle()

  expect(s.blits.length).toBeGreaterThanOrEqual(2)

  const D = 0x01000000
  const UPPER = 0x2580 // ▀ 上半块
  const LOWER = 0x2584 // ▄ 下半块
  const BLANK = 0x20

  const words = new Uint32Array(Uint8Array.fromBase64(s.blits[0]).buffer)
  expect(words.length).toBe(LAUGH.columns * LAUGH.rows * 3)

  // 第 f 帧第 (py, px) 个像素期望的颜色
  const pixel = (f: number, py: number, px: number): number => {
    const i = py * LAUGH.columns + px
    const byte = PATTERN[f * PX + i]
    return byte === 255 ? D : (LAUGH_PALETTE[byte] ?? D)
  }

  const wrong: string[] = []
  for (let y = 0; y < LAUGH.rows; y += 1) {
    for (let x = 0; x < LAUGH.columns; x += 1) {
      const top = pixel(0, y * 2, x)
      const bottom = pixel(0, y * 2 + 1, x)
      const o = (y * LAUGH.columns + x) * 3

      // pack() 的三条规则，照着抄一遍
      const want =
        top === D
          ? bottom === D
            ? [BLANK, D, D]
            : [LOWER, bottom, D]
          : [UPPER, top, bottom]
      const got = [words[o], words[o + 1], words[o + 2]]

      if (want[0] !== got[0] || want[1] !== got[1] || want[2] !== got[2]) {
        wrong.push(`(${x},${y}) 期望 ${want.map(v => v.toString(16))} 实得 ${got.map(v => v.toString(16))}`)
      }
    }
  }

  // 图案里每 3 个像素有 1 个透明，所以三种格子都应该出现过 —— 否则这条测试等于没测透明
  const codes = new Set(Array.from({ length: LAUGH.columns * LAUGH.rows }, (_, c) => words[c * 3]))
  expect([...codes].sort()).toEqual([BLANK, UPPER, LOWER].sort())

  expect(wrong.slice(0, 5)).toEqual([])
  expect(wrong.length).toBe(0)

  // 帧真的在往前走，不是同一张图重发 103 次
  expect(s.blits[1]).not.toBe(s.blits[0])
})

// ------------------------------------------------------------------ 下班彩蛋

test('下班触发降级：不试图开面板，但台词和音效照常', async ($, on) => {
  const s = engine(on, ['paplay'], { stored: { isOn: true } })
  const clock = mock.clock(on, { now: new Date(2026, 9, 3, 20, 0, 0).getTime() })
  // store 的桩已经在 engine() 里了，不能再叠一层 mock.store，
  // 同一个事件注册两次会把模块整个拒掉。

  // isInteractive: true 才会走进下班分支
  await $.session.start({ ...SESSION, isInteractive: true })
  await clock.settle()

  expect(s.opened).toBe(0) // 80 列落不下面板，压根不试
  expect(has(s, CLIP)).toBe(true) // 但得听个响
  expect(s.toasts.some(t => t.includes('这个点了还写呢'))).toBe(true)
})

// ============================================================================
// v0.2：看得懂上下文的陪伴
// ============================================================================

// ------------------------------------------------------- 台词跟着你说的话走

test('台词跟着用户的话走：说了 bug，台词里就有 bug', async ($, on) => {
  // 补刀固定走失败分支：这条测的是**本地模板**带不带你说的词。
  // 让模型的话有机会插进来就变成竞态了 —— 它一旦落地，屏幕上那句就换成
  // 「测试台词。」，`includes('bug')` 时真时假。LLM 成功那条路径由
  // 「异步补刀」和「输出不合规」两条测试负责。
  const s = engine(on, ['paplay'], {
    stored: { isOn: true },
    complete: () => ({ isAnswered: false, reason: 'api-error', status: 500, error: 'x', usage: USAGE }),
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  await warmUp($, clock)

  await $.prompt.submit({ text: '我今天写的全是 bug，烦死了' })

  const text = await bandText($)
  // 这是 Minus 的原始投诉：上一版这里会随机蹦出「我没有破防，我只是在加载笑声」
  expect(text.includes('bug')).toBe(true)
  // 他烦的时候奶蛙不该跟着生气（生气的对象是危险命令，不是他）
  expect((await paneText($)).includes('心情：平静')).toBe(true)
  expect(s.asks.length).toBeGreaterThan(0) // 补刀确实派出去了
})

test('LLM 是异步补刀：先本地台词，resolve 之后才换', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })

  const s = engine(on, [], {
    stored: { isOn: true },
    complete: async () => {
      await gate
      return ANSWER('这句话是模型生成的')
    },
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  await warmUp($, clock)

  await $.prompt.submit({ text: '今天有点烦，bug 一堆' })

  // 热路径上必须是本地模板 —— LLM 还没回来
  const local = await bandText($)
  expect(['热路径上是本地台词，带你说的词', local.includes('bug')]).toEqual([
    '热路径上是本地台词，带你说的词',
    true,
  ])
  expect(['热路径上还没换上模型的话', local.includes('模型生成')]).toEqual([
    '热路径上还没换上模型的话',
    false,
  ])

  release()
  await clock.settle()

  const patched = await bandText($)
  expect(['补刀落地，换成了模型那句', patched.includes('模型生成')]).toEqual([
    '补刀落地，换成了模型那句',
    true,
  ])
})

/**
 * 三种失败各来一遍。**必须是三个顶层 test** —— 一个 test 里 `on` 不能对
 * 同一个事件注册两次，所以每个用例都得有自己的引擎。
 */
async function expectFallback(
  $: Engine,
  on: On,
  complete: Init['complete'],
): Promise<void> {
  engine(on, [], { stored: { isOn: true }, complete })
  const clock = mock.clock(on, { now: 1_000_000 })
  await warmUp($, clock)

  await $.prompt.submit({ text: '今天有点烦，bug 一堆' })
  await clock.settle()

  const text = await bandText($)
  expect(text.includes('bug')).toBe(true) // 本地台词还在，没被清掉
}

test('LLM 报 api-error 时静默降级', async ($, on) => {
  await expectFallback($, on, async () => ({
    isAnswered: false,
    reason: 'api-error',
    status: 500,
    error: 'boom',
    usage: USAGE,
  }))
})

test('LLM 回空时静默降级', async ($, on) => {
  await expectFallback($, on, async () => ({ isAnswered: false, reason: 'empty-reply', usage: USAGE }))
})

test('LLM 直接抛异常（网关连不上）也静默降级', async ($, on) => {
  await expectFallback($, on, async () => {
    throw new Error('网关连不上')
  })
})

test('sanitize 拒绝代码块、超长、技术建议', async () => {
  for (const bad of [
    '```ts\nconst a = 1\n```',
    '这就是问题了，建议你检查一下这个函数的返回值是不是对的，应该先加个日志试试',
    '你应该把 /etc/hosts 改一下',
    '报错是因为空指针',
  ]) {
    expect([bad, sanitize(bad)]).toEqual([bad, null])
  }
  // 正常的一句话要能过
  expect(sanitize('齁齁齁，这个我在行。')).toBe('齁齁齁，这个我在行。')
  // markdown 装饰会被剥掉，不是拒绝
  expect(sanitize('**齁齁齁**')).toBe('齁齁齁')
  // 换行只取第一行
  expect(sanitize('齁齁齁。\n第二行')).toBe('齁齁齁。')
})

test('LLM 输出不合规时不改台词（端到端）', async ($, on) => {
  engine(on, [], {
    stored: { isOn: true },
    complete: () => ANSWER('你应该检查一下 /etc/hosts 这个文件的配置'),
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  await warmUp($, clock)

  await $.prompt.submit({ text: '今天有点烦，bug 一堆' })
  await clock.settle()

  const text = await bandText($)
  expect(text.includes('bug')).toBe(true)
  expect(text.includes('/etc/hosts')).toBe(false)
})

// ---------------------------------------------------------- 心情自己跟着变

test('危险命令：拦下的同时，脸和台词一起变生气', async ($, on) => {
  const s = engine(on, [], { stored: { isOn: true } })
  const clock = mock.clock(on, { now: 1_000_000 })
  // `on` 必须在第一次碰 `$` 之前全注册完 —— 底下的 hooks 是先于测试体挂上去的
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' } }))
  await warmUp($, clock)

  const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })

  expect(ran.deny).toBeDefined()
  const pane = await paneText($)
  // 上一版的 bug 就在这里：台词变生气但脸还是 calm
  expect(pane.includes('心情：生气')).toBe(true)
  expect(pane.includes('rm -rf')).toBe(true) // 判断依据是命中的那段命令
  expect(s.toasts.some(t => t.includes('摁住了'))).toBe(true)
})

test('密钥文件：deny + 生气，依据显示文件名', async ($, on) => {
  engine(on, [], { stored: { isOn: true } })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }))
  await warmUp($, clock)

  const ran = await $.tool.call({
    tool: 'Edit',
    file_path: '/home/minus/proj/.env',
    old_string: 'a',
    new_string: 'b',
  })

  expect(ran.deny).toBeDefined()
  const pane = await paneText($)
  expect(pane.includes('心情：生气')).toBe(true)
  expect(pane.includes('.env')).toBe(true)
})

test('冷却：一轮里只在开头说一句，不会每步都刷台词', async ($, on) => {
  engine(on, [], { stored: { isOn: true } })
  const clock = mock.clock(on, { now: 1_000_000 })
  await warmUp($, clock)

  await $.prompt.submit({ text: '帮我看看这个' })
  const first = await bandText($)
  expect(first).not.toBe('')

  // 同一时刻再来一轮：8 秒没到，不该换台词
  await $.prompt.submit({ text: '再看看别的' })
  expect(await bandText($)).toBe(first)

  await clock.advance(9_000)
  await $.prompt.submit({ text: '第三个问题' })
  expect(await bandText($)).not.toBe(first)
})

// -------------------------------------------------------------- 高光自动彩蛋

test('测试全绿 → 自动放一次彩蛋，且受间隔限制', async ($, on) => {
  const s = engine(on, ['paplay'], { stored: { isOn: true } })
  const clock = mock.clock(on, { now: 1_000_000 })
  // 命令跑完的结果要按**核心**的形状给：`text` 是模型读到的那段输出，
  // `isError` 只有核心会盖。插件读的就是这两个字段（`ToolCallResult` 里
  // 它们标着 "Set by core"），只回 `{ result }` 的话插件看不到「挂了」。
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: 'Test Files  3 passed (3)\n     Tests  12 passed (12)', stderr: '' },
    text: 'Test Files  3 passed (3)\n     Tests  12 passed (12)',
  }))
  await warmUp($, clock)

  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  await clock.advance(1_200)

  expect(s.blits.length).toBeGreaterThan(0) // 动画真的放起来了
  expect((await paneText($)).includes('心情：大笑')).toBe(true)

  // 动画播完（tick 归 null），但离 180 秒的间隔还远：再全绿也不放
  await clock.advance(13_000)
  const opened = s.opened
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  await clock.advance(1_200)
  expect(s.opened).toBe(opened)
})

test('连挂两次之后跑通 → 翻盘彩蛋，依据带次数', async ($, on) => {
  const s = engine(on, ['paplay'], { stored: { isOn: true } })
  const clock = mock.clock(on, { now: 1_000_000 })
  let isRed = true
  // `isError` 和 `text` 都要按核心的形状给（理由见上一条测试）
  on('tool.call', { tool: 'Bash' }, () =>
    isRed
      ? { isError: true, result: { stdout: 'Exit code 1', stderr: '' }, text: 'Exit code 1' }
      : { result: { stdout: '12 passed (12)', stderr: '' }, text: '12 passed (12)' },
  )
  await warmUp($, clock)

  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  await clock.advance(2_000)
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  await clock.advance(2_000)

  isRed = false
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  await clock.advance(1_200)

  const pane = await paneText($)
  expect(['依据里带着连挂次数', pane.includes('连挂 2 次后跑通')]).toEqual([
    '依据里带着连挂次数',
    true,
  ])
  expect(['翻盘之后是笑', pane.includes('心情：大笑')]).toEqual(['翻盘之后是笑', true])
  expect(['彩蛋真的放起来了', s.blits.length > 0]).toEqual(['彩蛋真的放起来了', true])
})

// ------------------------------------------------------------- /naiwa 开关

test('/naiwa 是持久开关：开一次，以后每次会话自动在场', async ($, on) => {
  const s = engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start(SESSION)
  await clock.advance(9_000)
  expect(s.store.get('isOn')).toBeUndefined()
  expect(await bandText($)).toBe('') // 默认闭嘴

  await $.command.run({ command: 'naiwa' })
  expect(s.store.get('isOn')).toBe(true) // 落盘了，才活得过重启
  expect(s.opened).toBe(1)
  expect(await bandText($)).not.toBe('') // 开口打招呼
  expect((await paneText($)).includes('心情：')).toBe(true)

  // 再敲一次 = 关掉
  await $.command.run({ command: 'naiwa' })
  expect(s.closed).toEqual(['naiwa'])
  expect(s.store.get('isOn')).toBe(false)
  expect(await bandText($)).toBe('') // 台词条一起收掉

  // 紧接着再开：你亲手叫的，不该被 8 秒冷却压住 ——
  // 压住的话面板开了、台词条却是空的（hush 刚清过），看着像坏了
  await $.command.run({ command: 'naiwa' })
  const back = await bandText($)
  expect(['关掉又立刻打开，台词条要回来', back !== '']).toEqual([
    '关掉又立刻打开，台词条要回来',
    true,
  ])
})

test('开关已经打开时，新会话自动出现，但不主动抢面板', async ($, on) => {
  const s = engine(on, [], { stored: { isOn: true } })
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start(SESSION)
  await clock.settle()

  expect(await bandText($)).not.toBe('') // 台词条常驻
  expect(s.opened).toBe(0) // 80 列落不下，不试（降级成台词条）
})

// ------------------------------------------------------------------ 面板形态

test('面板上没有任何可点的东西，只显示心情和判断依据', async ($, on) => {
  engine(on, [], { stored: { isOn: true } })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' } }))
  await warmUp($, clock)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })

  const ui = await $.ui.mount({
    plugin: 'naiwa',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'naiwa',
    props: PANE_PROPS,
  })
  try {
    // 智能陪伴不该有「换个表情」「大笑」这种要你按的按钮
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    expect(await ui.findAll({ type: 'Input' })).toEqual([])
    expect(await ui.findAll({ type: 'Select' })).toEqual([])
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(texts.includes('心情：')).toBe(true)
    expect(texts.includes('拦截 1')).toBe(true)
  } finally {
    await ui.unmount()
  }
})

// ------------------------------------------------------------------ 纯函数

test('判定表：事件 → 场合，不需要引擎', async () => {
  const of = (signal: Parameters<typeof occasionOf>[0]): string | undefined =>
    occasionOf(signal)?.occasion

  // 你的话
  expect(of({ kind: 'prompt', text: '我今天写的全是 bug' })).toBe('frustrated')
  expect(of({ kind: 'prompt', text: '哈哈哈哈这个太强了' })).toBe('banter')
  expect(of({ kind: 'prompt', text: '终于上线了' })).toBe('milestone')
  expect(of({ kind: 'prompt', text: '帮我看看这个函数' })).toBe('prompt')
  // 「debug」不算「bug」—— 那是个正常请求，不是你破防了
  expect(of({ kind: 'prompt', text: '帮我 debug 这个' })).toBe('prompt')

  // 命令
  expect(of({ kind: 'bashCall', command: 'rm -rf build' })).toBe('blocked')
  expect(of({ kind: 'bashCall', command: 'ls -la' })).toBeUndefined()
  expect(of({ kind: 'writeCall', path: 'a/.env' })).toBe('secret')
  expect(of({ kind: 'writeCall', path: 'a/main.ts' })).toBeUndefined()

  // 跑完的结果
  expect(of({ kind: 'bashResult', command: 'ls', isError: true, text: '', failStreak: 0 })).toBe('fail')
  expect(of({ kind: 'bashResult', command: 'tsc', isError: false, text: '', failStreak: 0 })).toBe('green')
  const suite = { kind: 'bashResult', command: 'npx vitest run', isError: false, text: '12 passed' } as const
  expect(of({ ...suite, failStreak: 0 })).toBe('greenlight')
  expect(of({ ...suite, failStreak: 2 })).toBe('recovered')
  // 保守判绿：输出里带失败计数就不算绿 —— 而且**必须是 fail，不能是静默**。
  // 这条踩过坑：SUITE 分支一度掉进下面的 VERIFY，而 `vitest` 也在 VERIFY 里，
  // 于是一次挂掉的测试运行被判成了「验证通过」。
  expect(of({ ...suite, text: '1 failed', failStreak: 0 })).toBe('fail')
  expect(of({ ...suite, isError: true, failStreak: 0 })).toBe('fail')
  // 普通编辑/命令成功不值得开口
  expect(of({ kind: 'bashResult', command: 'ls', isError: false, text: '', failStreak: 0 })).toBeUndefined()

  // 冷却
  expect(shouldSpeak('urgent', 0, 0)).toBe(true) // 拦截无条件开口，不读时钟
  expect(shouldSpeak('normal', 0, 7_999)).toBe(false)
  expect(shouldSpeak('normal', 0, 8_000)).toBe(true)
  expect(shouldSpeak('notable', 0, 1_499)).toBe(false)
  expect(shouldSpeak('notable', 0, 1_500)).toBe(true)

  expect(occasionOf({ kind: 'turn', reason: 'answer' })).toBeNull()
  expect(of({ kind: 'turn', reason: 'error' })).toBe('turnfail')
})

test('每条模板渲染后都 ≤30 字、单行', async () => {
  const tooLong: string[] = []
  for (const [occasion, pool] of Object.entries(TEMPLATES)) {
    for (const template of pool) {
      for (const hit of ['', 'x'.repeat(HIT_MAX)]) {
        const text = renderTemplate(template, hit)
        if (text.length > MAX_LINE || text.includes('\n') || text.trim() === '') {
          tooLong.push(`${occasion}: ${text} (${text.length})`)
        }
      }
    }
  }
  expect(tooLong).toEqual([])

  // 每个场合都得有台词可挑，不能空池
  for (const [occasion, pool] of Object.entries(TEMPLATES)) {
    expect([occasion, pool.length > 0]).toEqual([occasion, true])
  }
})
