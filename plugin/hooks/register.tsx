/**
 * 奶蛙 · 全部行为。
 *
 * 三条硬约束写在 docs/superpowers/specs/2026-10-03-naiwa-mod-design.md，
 * 别绕过去：
 *  1. `$.audio.play` 在 Linux 上不播 —— 见 audio.ts。
 *  2. 被动开面板要 ≥144 列（被主动开过一次后 110 列），本机终端 80 列，
 *     所以「下班」自动触发永远落不下面板，只能降级成音频 + 台词 + toast。
 *  3. `$.ui.blit` 在 Raster 未挂载时返回 `{ deny }`（面板被关掉了），
 *     不是错误，直接 cancel 定时器收摊。
 */

import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  PluginOptions,
  Register,
  SessionStartInput,
  Timer,
} from 'claude-code'

import type { Mood, Tally } from '../types'
import {
  BIN_DIRS,
  CLIP_ASSET,
  CRY,
  PLAY_TIMEOUT_MS,
  PLAYER_NAMES,
  SPEAK_TIMEOUT_MS,
  SPEAKER_NAMES,
  modeOf,
  plan,
  platformOf,
  playerArgv,
} from './audio'
import type { Platform } from './audio'
import { ART, ART_COLUMNS, ART_ROWS } from './art'
import { LAUGH, LAUGH_PALETTE, LAUGH_TRANSPARENT } from './laugh-meta'
import { DIALECT, pick } from './lines'

const PANE = 'naiwa'
const TITLE = '🐸 奶蛙工位'
const FACE_KEY = 'face'
const PANE_COLUMNS = 46
const OFF_WORK_HOUR = 18
const STORE_OFF_WORK = 'offWorkDate'

/** Raster 单元格：`▀` 一行画两像素，前景 = 上、背景 = 下。 */
const DEFAULT = 0x01000000
const UPPER = 0x2580
const LOWER = 0x2584
const BLANK = 0x20

const mood = atom({ plugin: 'naiwa', key: 'mood' } as const, 'calm' as Mood)
const line = atom({ plugin: 'naiwa', key: 'line' } as const, '')
const tally = atom({ plugin: 'naiwa', key: 'tally' } as const, {
  edits: 0,
  commands: 0,
  failures: 0,
  blocked: 0,
} as Tally)
const isDialect = atom({ plugin: 'naiwa', key: 'isDialect' } as const, false)
const isLaughing = atom({ plugin: 'naiwa', key: 'isLaughing' } as const, false)

/**
 * 破坏性命令。命中就 deny，不放行。
 * 这条规则和 Minus 自己的红线对齐：删文件、动 git 历史、碰密钥，都要先停下来。
 */
const DANGER = new RegExp(
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
const PROTECTED = new RegExp(
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
const VERIFY = /\b(test|tests|pytest|vitest|jest|tsc|typecheck|lint|build|make|cargo|gradle|mvn)\b/i

function describeDanger(command: string): string {
  if (/\brm\b/i.test(command)) return '它会删文件'
  if (/reset\s+--hard/i.test(command)) return '它会丢掉没提交的改动'
  if (/--force|\s-f(\s|$)/.test(command)) return '它可能强推、覆盖远端历史'
  if (/\bmkfs|\bdd\b/i.test(command)) return '它会往裸设备上写'
  if (/chmod\s+-R\s+777/i.test(command)) return '它会把权限整个放开'
  return '它是不可逆的破坏性操作'
}

// ------------------------------------------------------------------ 音效执行

/**
 * 平台和播放器在 `session.start` 探测一次并缓存到这里。
 * `$.process.run` 默认 30s 超时，不能每次播放都探测一遍。
 */
let platform: Platform = 'other'
let player: string | null = null
let speaker: string | null = null
let isDetected = false

async function firstOnPath($: EngineInterface, names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    for (const dir of BIN_DIRS) {
      try {
        if (await $.fs.exists(`${dir}/${name}`)) return `${dir}/${name}`
      } catch {
        // fs.exists 只对网络位置 reject，这里当不存在
      }
    }
  }
  return null
}

async function detect($: EngineInterface): Promise<void> {
  if (isDetected) return
  isDetected = true
  try {
    const { stdout } = await $.process.run(['uname', '-s'])
    platform = platformOf(stdout)
  } catch {
    platform = 'other'
  }
  if (platform === 'darwin') return
  player = await firstOnPath($, PLAYER_NAMES)
  speaker = await firstOnPath($, SPEAKER_NAMES)
}

/** 放彩蛋音效。永远 resolve、永远不抛 —— 没声音也不该让彩蛋报错。 */
async function playLaugh($: EngineInterface, options: PluginOptions): Promise<void> {
  const steps = plan(modeOf(options), platform, player !== null)
  for (const step of steps) {
    try {
      if (step.kind === 'skip') return
      if (step.kind === 'asset') {
        await $.audio.play({ asset: CLIP_ASSET })
        return
      }
      if (step.kind === 'player' && player !== null) {
        const ran = await $.process.run(playerArgv(player, `${$.plugin.root}/${CLIP_ASSET}`), {
          timeoutMs: PLAY_TIMEOUT_MS,
        })
        if (ran.exitCode === 0) return
        continue
      }
      if (step.kind === 'speak') {
        if (platform === 'darwin') {
          await $.audio.speak(CRY)
          return
        }
        if (speaker === null) return
        await $.process.run([speaker, CRY], { timeoutMs: SPEAK_TIMEOUT_MS })
        return
      }
    } catch {
      // 试下一步
    }
  }
}

// ---------------------------------------------------------------- Raster 编码

/**
 * 网格 → `columns*rows` 个小端 u32 三元组 `[码点, 前景, 背景]` 的 base64。
 * `at(y, x)` 返回 0xRRGGBB 或 DEFAULT（透明）。
 */
function pack(at: (y: number, x: number) => number, columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const top = at(y * 2, x)
      const bottom = at(y * 2 + 1, x)
      const o = (y * columns + x) * 3
      if (top === DEFAULT) {
        // 上半透明：用下半块，或者干脆留空格
        words[o] = bottom === DEFAULT ? BLANK : LOWER
        words[o + 1] = bottom
        words[o + 2] = DEFAULT
      } else {
        words[o] = UPPER
        words[o + 1] = top
        words[o + 2] = bottom
      }
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}

function artCells(m: Mood): { cells: string; columns: number; rows: number } {
  const grid = ART[m] ?? ART.calm
  return {
    cells: pack((y, x) => grid[y][x], ART_COLUMNS, ART_ROWS),
    columns: ART_COLUMNS,
    rows: ART_ROWS,
  }
}

/** laugh.bin 第 `frame` 帧 → cells。每像素 1 字节调色板下标，255 = 透明。 */
function frameCells(data: Uint8Array, frame: number): string {
  const { columns, rows } = LAUGH
  const base = frame * columns * rows * 2
  return pack(
    (y, x) => {
      const i = data[base + y * columns + x]
      return i === LAUGH_TRANSPARENT ? DEFAULT : (LAUGH_PALETTE[i] ?? DEFAULT)
    },
    columns,
    rows,
  )
}

// ------------------------------------------------------------------ 动画播放

let tick: Timer | null = null
let frames: Uint8Array | null = null

function stopTicker(): void {
  if (tick !== null) {
    tick.cancel()
    tick = null
  }
}

async function loadFrames($: EngineInterface): Promise<Uint8Array | null> {
  if (frames !== null) return frames
  try {
    const { base64 } = await $.fs.read(`${$.plugin.root}/data/laugh.bin`, { as: 'bytes' })
    frames = Uint8Array.fromBase64(base64)
    return frames
  } catch {
    return null
  }
}

/**
 * 大笑彩蛋：音频与动画并行，103 帧播完自停。
 *
 * 属于「用户主动」（按钮或 /naiwa-laugh），所以 80 列也能落面板。
 * 任何一条退出路径都必须 cancel 掉定时器，否则面板关了它还在跑。
 */
async function startLaugh($: EngineInterface, options: PluginOptions): Promise<void> {
  if (tick !== null) return

  await update($, mood, () => 'laugh')
  await update($, line, () => pick('laugh', Date.now()))
  void playLaugh($, options)

  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
  if (!opened.isPlaced) {
    // 窄终端：面板落不下，动画也就没法 blit。音频和台词照常。
    $.ui.toast('奶蛙：屏幕太窄，动画放不下 —— 听个响吧，齁齁齁')
    return
  }

  const data = await loadFrames($)
  if (data === null) {
    $.ui.toast('奶蛙：帧数据没读出来，齁……')
    return
  }

  await update($, isLaughing, () => true)
  let frame = 0
  let isBusy = false

  const finish = (): void => {
    stopTicker()
    void update($, isLaughing, () => false)
    void update($, mood, () => 'calm')
  }

  tick = $.clock.every(Math.round(1000 / LAUGH.fps), () => {
    if (isBusy) return
    if (frame >= LAUGH.frames) {
      finish()
      return
    }
    isBusy = true
    void $.ui
      .blit({
        requestId: PANE,
        key: FACE_KEY,
        cells: frameCells(data, frame),
        columns: LAUGH.columns,
        rows: LAUGH.rows,
      })
      // deny = 面板已经被关掉了，不是错误，收摊
      .then(result => {
        if (result.deny !== undefined) finish()
      })
      .catch(() => finish())
      .finally(() => {
        isBusy = false
      })
    frame += 1
  })
}

// -------------------------------------------------------------------- 行为

async function say($: EngineInterface, m: Mood, force = false): Promise<void> {
  if (!force && (await read($, isLaughing))) return
  if (!force) await update($, mood, () => m)
  await update($, line, () => pick(m, Date.now()))
}

async function cycle($: EngineInterface): Promise<void> {
  const order: readonly Mood[] = ['calm', 'angry', 'laugh']
  const now = await read($, mood)
  const nextMood = order[(order.indexOf(now) + 1) % order.length]
  await update($, mood, () => nextMood)
  await update($, line, () => pick(nextMood, Date.now()))
}

/** 下班彩蛋的降级版：只放音频 + 台词 + toast，不尝试开面板（80 列落不下）。 */
async function offWork(
  $: EngineInterface,
  e: SessionStartInput,
  options: PluginOptions,
): Promise<void> {
  try {
    if (!e.isInteractive) return
    const now = new Date(await $.clock.now())
    if (now.getHours() < OFF_WORK_HOUR) return
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    if ((await $.store.get(STORE_OFF_WORK)) === today) return
    await $.store.set(STORE_OFF_WORK, today)

    await say($, 'laugh', true)
    void playLaugh($, options)
    $.ui.toast('🐸 奶蛙：这个点了还写呢？齁齁齁齁齁——')
  } catch {
    // 彩蛋失败不该影响会话
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await detect($)
    await $.command.register({ name: 'naiwa', description: '打开奶蛙工位面板' })
    await $.command.register({ name: 'naiwa-laugh', description: '奶蛙大笑彩蛋：动画 + 配音 + 台词' })
    await $.command.register({ name: 'naiwa-talk', description: '开关奶蛙口吻（注入 system prompt）' })
    $.ui.status('🐸 奶蛙在岗 · 齁齁齁')
    void offWork($, e, options)
    return next(e)
  })

  on('command.run', { command: 'naiwa' }, async ($, e, next) => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
    if (!opened.isPlaced) return { text: `🐸 面板没能放下来（${opened.reason}）—— 加宽终端到 110 列再试。` }
    return next(e)
  })

  on('command.run', { command: 'naiwa-laugh' }, async $ => {
    await startLaugh($, options)
    return { text: '🐸 奶蛙：哈哈哈哈哈哈哈哈哈哈哈哈哈哈' }
  })

  on('command.run', { command: 'naiwa-talk' }, async ($, e, next) => {
    const isOn = !(await read($, isDialect))
    await update($, isDialect, () => isOn)
    return isOn
      ? { text: '🐸 奶蛙口吻：开了。齁齁齁，不过技术结论还是照实说。' }
      : next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, isDialect))) return composed
    return {
      ...composed,
      sections: [
        ...composed.sections,
        { id: 'naiwa:dialect', text: DIALECT, scope: 'session' as const },
      ],
    }
  })

  on('prompt.submit', async ($, e, next) => {
    await say($, 'calm')
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')

    if (DANGER.test(command)) {
      await update($, tally, t => ({ ...t, blocked: t.blocked + 1 }))
      await say($, 'angry', true)
      $.ui.toast('🐸 奶蛙：这条命令奶蛙给你摁住了')
      return {
        deny: `🐸 奶蛙拦下了这条命令：${describeDanger(command)}。真要跑，请在 Claude Code 之外的终端里自己执行。`,
      }
    }

    await update($, tally, t => ({ ...t, commands: t.commands + 1 }))
    const ran = await next(e)
    const isRed = ran.isError === true || /Exit code [1-9]\d*/.test(ran.text ?? '')

    if (ran.deny === undefined && isRed) {
      await update($, tally, t => ({ ...t, failures: t.failures + 1 }))
      await say($, 'angry')
    } else if (ran.deny === undefined && VERIFY.test(command)) {
      await say($, 'laugh')
    }
    return ran
  })

  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      if (PROTECTED.test(e.file_path)) {
        await update($, tally, t => ({ ...t, blocked: t.blocked + 1 }))
        await say($, 'angry', true)
        return {
          deny: `🐸 奶蛙不让动 ${e.file_path} —— 密钥和凭据文件不进代码、不进 commit。真要改，请你自己来。`,
        }
      }
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        await update($, tally, t => ({ ...t, edits: t.edits + 1 }))
      }
      return ran
    })
  }

  on('turn.complete', async ($, e, next) => {
    if (e.reason === 'answer') await say($, 'calm')
    else if (e.reason === 'error' || e.reason === 'aborted') await say($, 'angry')
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, line)
    if (text === '') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="#FCDF69">🐸 奶蛙：</Text>
        <Text>{text}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Raster } = elements
    const [m, text, t] = [await read($, mood), await read($, line), await read($, tally)]
    const face = e.surface === 'terminal' && Raster !== undefined ? artCells(m) : null

    return (
      <Box flexDirection="column" paddingX={1}>
        {face !== null ? (
          <Raster key={FACE_KEY} columns={face.columns} rows={face.rows} cells={face.cells} />
        ) : (
          <Text color="#FCDF69">🐸 奶蛙</Text>
        )}
        <Text color="#FCDF69">「{text === '' ? '齁齁齁。' : text}」</Text>
        <Text dimColor>
          编辑 {t.edits} · 命令 {t.commands} · 失败 {t.failures} · 拦截 {t.blocked}
        </Text>
        <Box>
          <Button key="laugh" label="大笑" variant="primary" onPress={() => void startLaugh($, options)} />
          <Text> </Text>
          <Button key="cycle" label="换个表情" onPress={() => void cycle($)} />
        </Box>
      </Box>
    )
  })
}
