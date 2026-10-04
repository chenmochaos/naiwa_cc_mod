/**
 * `claude plugin test plugin/`
 *
 * 两件事必须先搞清楚，否则测试根本跑不起来：
 *
 * 1. **测试里的 `$` 只有「驱动用」的一部分**（tool/command/prompt/session/ui/…），
 *    没有 `fs`/`process`/`clock`/`store`/`state`。所以别在测试体里直接调
 *    `$.fs.exists`，只能通过插件的行为间接触发。
 * 2. **插件在 hook 里拿到的 `$` 是完整引擎**，它调的每个 `$.noun.verb` 都会
 *    变成事件，`on(...)` 注册的 hook 站在插件**下面**当实现。op 事件的 hook 是
 *    `($, e) => ({ value })`（注意第一个参数是 `$`，不是 `e`），
 *    `tool.call` 则是 `{ result }` / `{ deny }`。
 *
 * 好处：「插件到底做了什么」可以被完整观测 —— 尤其是它有没有偷偷调
 * `$.audio.play`（Linux 上那个是死路，见 audio.ts）。
 */

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { LAUGH, LAUGH_PALETTE } from './laugh-meta'

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

type Stubs = {
  registered: string[]
  toasts: string[]
  argv: string[][]
  audioPlays: number
  spoke: string[]
  opened: number
  blits: string[]
}

/**
 * 站在插件底下的「引擎」。
 * `bins` 是 `fs.exists` 报存在的可执行文件基名 —— 控制探测到 paplay 还是 spd-say。
 */
function engine(on: On, bins: readonly string[] = []): Stubs {
  const s: Stubs = {
    registered: [],
    toasts: [],
    argv: [],
    audioPlays: 0,
    spoke: [],
    opened: 0,
    blits: [],
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
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))

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
  const s = engine(on, ['paplay'])
  const clock = mock.clock(on, { now: new Date(2026, 9, 3, 20, 0, 0).getTime() })
  // store 的 stub 已经在 engine() 里了（`store.get` 答 undefined = 今天还没播过），
  // 不能再叠一层 mock.store，同一个事件注册两次会把模块整个拒掉。

  // isInteractive: true 才会走进下班分支
  await $.session.start({ ...SESSION, isInteractive: true })
  await clock.settle()

  expect(s.opened).toBe(0) // 80 列落不下面板，压根不试
  expect(has(s, CLIP)).toBe(true) // 但得听个响
  expect(s.toasts.some(t => t.includes('这个点了还写呢'))).toBe(true)
})
