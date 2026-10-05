/**
 * 奶蛙 · 全部行为（编排层）。
 *
 * 分工：决策全在纯模块里（signals.ts 判场合、lines.ts 出台词、gen.ts 构造与净化
 * LLM 请求），这个文件只负责「把事件接上、把 `$` 调出去、把状态写回去」。
 * 之所以这么切，是因为 `$` 只能传进本文件内声明的函数，不能跨 import。
 *
 * 五条硬约束，别绕过去：
 *  1. `$.audio.play` 在 Linux 上不播 —— 见 audio.ts。
 *  2. **被动开面板要 ≥144 列（被主动开过一次后 110 列）**，本机终端 80 列，
 *     所以 `session.start` 里那次开面板在窄终端上落不下去。救命的是「asked」
 *     语义：你亲手敲的命令、你发的消息都算你要的，任何宽度都能落 ——
 *     见 `ensurePane` 为什么挂在 `prompt.submit` 上。
 *  3. **脸比面板高是这个插件最容易复发的 bug。** 面板行数是引擎给的（80×24 只有
 *     6 行），别写死尺寸 —— 一律走 `chooseLayout(bodyRows)` 挑档。
 *  4. `$.ui.blit` 在 Raster 未挂载时返回 `{ deny }`（面板被关掉了），
 *     不是错误，直接 cancel 定时器收摊。
 *  5. **被拦下的命令必须每次都能说话，所以 urgent 场合一次都不读时钟。**
 *     register.test.ts 的 T1/T2/T4/T5 没搭 `mock.clock`，读一下就是
 *     "no implementation"。见 signals.ts 的 shouldSpeak。
 */

import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  PluginOptions,
  Register,
  SessionStartInput,
  Timer,
} from 'claude-code'

import type { Mood, Speech, Tally } from '../types'
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
import { FACES, FACE_PALETTE, FACE_TRANSPARENT } from './face-meta'
import type { FaceTierName } from './face-meta'
import { chooseLayout } from './faces'
import { LAUGH, LAUGH_PALETTE, LAUGH_TRANSPARENT } from './laugh-meta'
import { DIALECT, MOOD_NAME, fill, reasonOf } from './lines'
import { MOOD_OF, PRIORITY_OF, describeDanger, occasionOf, shouldSpeak } from './signals'
import type { Occasion } from './signals'
import {
  GEN_MAX_PER_SESSION,
  GEN_MIN_GAP_MS,
  MODEL_WORTHY,
  buildRequest,
  sanitize,
} from './gen'

const PANE = 'naiwa'
const TITLE = '🐸 奶蛙工位'
const FACE_KEY = 'face'
const PANE_COLUMNS = 46
const OFF_WORK_HOUR = 18
const STORE_OFF_WORK = 'offWorkDate'
/** /naiwa 开关的真源。跨会话、跨重启，只有它管用。 */
const STORE_ON = 'isOn'

/** Raster 单元格：`▀` 一行画两像素，前景 = 上、背景 = 下。 */
const DEFAULT = 0x01000000
const UPPER = 0x2580
const LOWER = 0x2584
const BLANK = 0x20

const mood = atom({ plugin: 'naiwa', key: 'mood' } as const, 'calm' as Mood)
const line = atom({ plugin: 'naiwa', key: 'line' } as const, '')
const reason = atom({ plugin: 'naiwa', key: 'reason' } as const, '')
const tally = atom({ plugin: 'naiwa', key: 'tally' } as const, {
  edits: 0,
  commands: 0,
  failures: 0,
  blocked: 0,
  failStreak: 0,
} as Tally)
const isDialect = atom({ plugin: 'naiwa', key: 'isDialect' } as const, false)
const isLaughing = atom({ plugin: 'naiwa', key: 'isLaughing' } as const, false)
const isActive = atom({ plugin: 'naiwa', key: 'isActive' } as const, false)
/** 一个会话开始时的说话账本：没开过口、没有冷却、没有历史。 */
const EMPTY_SPEECH: Speech = { at: 0, occasion: '', seq: 0, recent: [] }
const speech = atom({ plugin: 'naiwa', key: 'speech' } as const, EMPTY_SPEECH)

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

/**
 * faces.bin 的一档 → cells。每像素 1 字节色板下标，255 = 透明。
 * 写法照抄下面的 `frameCells` —— 区别只是多一层档位偏移。
 */
function faceCells(
  data: Uint8Array,
  m: Mood,
  tier: FaceTierName,
): { cells: string; columns: number; rows: number } | null {
  const slot = FACES[m]?.[tier]
  if (slot === undefined) return null
  const { columns, rows, offset } = slot
  return {
    cells: pack((y, x) => {
      const i = data[offset + y * columns + x]
      return i === FACE_TRANSPARENT ? DEFAULT : (FACE_PALETTE[i] ?? DEFAULT)
    }, columns, rows),
    columns,
    rows,
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

/** 13KB，读一次就够 —— 面板每次重绘都读盘太浪费。 */
let faces: Uint8Array | null = null

async function loadFaces($: EngineInterface): Promise<Uint8Array | null> {
  if (faces !== null) return faces
  try {
    const { base64 } = await $.fs.read(`${$.plugin.root}/data/faces.bin`, { as: 'bytes' })
    faces = Uint8Array.fromBase64(base64)
    return faces
  } catch {
    return null
  }
}

/**
 * 大笑彩蛋：音频与动画并行，103 帧播完自停。
 *
 * 只管动画本身，**不碰 mood / line / reason** —— 谁来播谁负责说那句话。
 * 自动彩蛋（celebrate）已经在 `speak` 里把台词和判断依据写好了，这里再写一遍
 * 就会把「连挂 2 次后跑通」这种依据冲掉，面板上就看不出来它为什么笑。
 *
 * 属于「用户主动」（/naiwa-laugh）时 80 列也能落面板，也不受 /naiwa 开关限制
 * —— 你亲手敲的命令，工具就该听。
 * 任何一条退出路径都必须 cancel 掉定时器，否则面板关了它还在跑。
 */
async function startLaugh(
  $: EngineInterface,
  options: PluginOptions,
  /** 自动触发时为 false：没人点它，别为「面板太窄」弹 toast 打扰人。 */
  announce = true,
): Promise<void> {
  if (tick !== null) return
  void playLaugh($, options)

  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
  if (!opened.isPlaced) {
    // 窄终端：面板落不下，动画也就没法 blit。音频和台词照常。
    if (announce) $.ui.toast('奶蛙：屏幕太窄，动画放不下 —— 听个响吧，齁齁齁')
    return
  }

  const data = await loadFrames($)
  if (data === null) {
    if (announce) $.ui.toast('奶蛙：帧数据没读出来，齁……')
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

// ---------------------------------------------------------------- LLM 台词

/** 会话级的调用预算与节流。热重载会重置，可以接受。 */
let genSpent = 0
let genLastAt = Number.NEGATIVE_INFINITY
let genAbort: AbortController | null = null

function resetGenBudget(): void {
  genSpent = 0
  genLastAt = Number.NEGATIVE_INFINITY
}

type SpeakInput = {
  occasion: Occasion
  /** 填进台词槽位的词。 */
  hit?: string
  /** 面板上那句判断依据，通常来自 Verdict.why。 */
  why?: string
  /** 你的原话，只有 LLM 那一层用得上。 */
  said?: string
}

/**
 * 异步补刀：本地台词已经在屏幕上了，这里失败了就当没发生。
 *
 * 三层守卫，任何一层不过都静默返回：
 *  1. 预算（每会话 3 次、间隔 15s、超时 8s）；
 *  2. `sanitize`（长度、禁用词、markdown、emoji）；
 *  3. seq 对账（这期间又开过口就把旧回复丢掉，别让旧话盖新反应）。
 */
async function generate($: EngineInterface, input: SpeakInput, seq: number): Promise<void> {
  if (genSpent >= GEN_MAX_PER_SESSION) return
  try {
    const now = await $.clock.now()
    if (now - genLastAt < GEN_MIN_GAP_MS) return
    genSpent += 1
    genLastAt = now

    genAbort?.abort()
    const controller = new AbortController()
    genAbort = controller

    // 用会话在用的模型名，跟你在 /model 里看到的一致（实测网关并不拦别的名字，
    // 但保持一致才不会出现「插件偷偷用了另一个模型」这种事）。
    const model = await $.session.model()
    const answer = await $.model.complete(
      buildRequest(
        { occasion: input.occasion, hit: input.hit ?? '', userText: input.said ?? '' },
        model,
      ),
      { signal: controller.signal },
    )
    if (!answer.isAnswered) return

    const text = sanitize(answer.text)
    if (text === null) return

    const current = await read($, speech)
    if (current.seq !== seq) return

    await update($, line, () => text)
    await update($, speech, s => ({ ...s, recent: [text, ...s.recent].slice(0, 3) }))
  } catch {
    // 静默降级：本地台词已经在屏幕上，这里什么都不用做
  }
}

/**
 * 奶蛙开口。
 *
 * 三件事一次做完，**心情永远跟着场合走** —— 上一版的 bug 正出在这里：
 * `say($, 'angry', force=true)` 只换了台词没换 mood，于是拦下危险命令时
 * 脸还是 calm，只有字变了。现在 `force` 这个双关参数整个删掉，
 * 「要不要受冷却/开关限制」由 priority 决定，和「写不写 mood」彻底分开。
 */
async function speak($: EngineInterface, input: SpeakInput): Promise<void> {
  if (!(await read($, isActive))) return

  const priority = PRIORITY_OF[input.occasion]
  // 笑着的时候不插嘴，除非是拦截 —— 那必须立刻反应，并顺手把动画收掉
  if (priority !== 'urgent' && (await read($, isLaughing))) return

  const previous = await read($, speech)
  let at = previous.at
  if (priority === 'notable' || priority === 'normal') {
    // 只有这两档碰时钟。urgent 的测试环境里压根没有 clock。
    const now = await $.clock.now()
    // 冷却压的是「同一件事别重复说」，**不是「状态不许变」**。心情翻篇（平静→失落、
    // 大笑→失落）必须落下来 —— 被上一句话的冷却吃掉的话，脸和台词条会停在旧心情上，
    // 「失落」就永远等不到（2026-10-05 那个「改了表情从没触发过」的疑问有一半出在这）。
    // 心情没变 = 纯粹重复，这才交给冷却压。
    const turned = (await read($, mood)) !== MOOD_OF[input.occasion]
    if (!turned && !shouldSpeak(priority, previous.at, now)) return
    at = now
  }
  if (priority === 'urgent') stopTicker()

  const hit = input.hit ?? ''
  const text = fill(input.occasion, hit, previous.recent, Date.now())
  const seq = previous.seq + 1

  await update($, mood, () => MOOD_OF[input.occasion])
  await update($, line, () => text)
  await update($, reason, () => reasonOf(input.occasion, input.why ?? ''))
  await update($, speech, () => ({
    at,
    occasion: input.occasion,
    seq,
    recent: [text, ...previous.recent].slice(0, 3),
  }))

  if (MODEL_WORTHY.includes(input.occasion)) void generate($, input, seq)
}

/** 闭嘴：把台词条和判断依据一起清掉。关开关时用。 */
async function hush($: EngineInterface): Promise<void> {
  stopTicker()
  await update($, line, () => '')
  await update($, reason, () => '')
  await update($, isLaughing, () => false)
  await update($, mood, () => 'calm')
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

    await speak($, { occasion: 'offwork' })
    void playLaugh($, options)
    $.ui.toast('🐸 奶蛙：这个点了还写呢？齁齁齁齁齁——')
  } catch {
    // 彩蛋失败不该影响会话
  }
}

// ------------------------------------------------------------------ 自动彩蛋

/**
 * 高光时刻才配自动放动画：整套测试跑全绿、或者连挂几次之后翻盘。
 * 预算卡得很紧 —— 每会话 2 次、两次至少隔 3 分钟。放太勤就不叫彩蛋了。
 */
const EGG_MAX_PER_SESSION = 2
const EGG_MIN_GAP_MS = 180_000

let eggSpent = 0
let eggLastAt = Number.NEGATIVE_INFINITY

function resetEggBudget(): void {
  eggSpent = 0
  eggLastAt = Number.NEGATIVE_INFINITY
}

async function celebrate(
  $: EngineInterface,
  options: PluginOptions,
  occasion: Occasion,
): Promise<void> {
  if (occasion !== 'greenlight' && occasion !== 'recovered') return
  if (!(await read($, isActive))) return
  if (eggSpent >= EGG_MAX_PER_SESSION) return
  try {
    const now = await $.clock.now()
    if (now - eggLastAt < EGG_MIN_GAP_MS) return
    eggSpent += 1
    eggLastAt = now
    await startLaugh($, options, false)
  } catch {
    // 彩蛋失败不该影响会话
  }
}

// ---------------------------------------------------------------- 面板在场

/**
 * 开关开着、面板却不在台上时，把它叫上来。已经在台上了就什么都不做。
 *
 * **为什么不能只在 `session.start` 里 `$.ui.open` 一次就算完**：引擎只让「asked」
 * 的开面板落座，没人要求的那种要 ≥144 列（这个 id 以前被开过才降到 110）。
 * 而本机 80 列的终端 —— 也就是大多数终端 —— 根本够不着。所以开关是开的、
 * 面板却不在，看着就是「打开 /naiwa 没有奶蛙」。
 *
 * 解法是**换时机**：`session.start` 那次照发（宽终端当场就落，窄终端石沉大海，
 * 不报错）；真正的抓手挂在 `prompt.submit` —— 你发消息 = 你要的，任何宽度都落。
 * 于是窄终端里你一打字，奶蛙就上来了，而不是永远差 64 列。
 *
 * 顺带一提：重复 `open` 同一个 id 是幂等的（引擎不会开出第二个），
 * 所以这里的 `panes()` 查询只是省一次无谓的调用，不是为了正确性。
 */
async function ensurePane($: EngineInterface): Promise<boolean> {
  if (!(await read($, isActive))) return false
  try {
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE && pane.isPlaced)) return true
  } catch {
    // 问不到就当它不在，下面重开一次没有副作用
  }
  try {
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
    return opened.isPlaced
  } catch {
    return false
  }
}

// -------------------------------------------------------------------- 注册

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await detect($)
    await $.command.register({ name: 'naiwa', description: '叫奶蛙上岗 / 让它下班（开关会记住）' })
    await $.command.register({ name: 'naiwa-laugh', description: '奶蛙大笑彩蛋：动画 + 配音 + 台词' })
    await $.command.register({ name: 'naiwa-talk', description: '开关奶蛙口吻（注入 system prompt）' })

    resetGenBudget()
    resetEggBudget()

    // 新会话 = 新的账本。atom 活得过热重载（也活得过同一进程里的下一场会话），
    // 不清的话上一场的冷却和「最近说过什么」会带进来 —— 最直观的症状是
    // 开场那句寒暄被上一场的冷却压掉，奶蛙一声不吭。
    await update($, speech, () => EMPTY_SPEECH)
    // 同理，上一场留在屏幕上的台词不该跨会话显示。
    await hush($)

    // $.store 的值变化不会触发重绘，必须镜像进 atom 面板才会刷新。
    const isOn = (await $.store.get(STORE_ON)) === true
    await update($, isActive, () => isOn)

    if (!isOn) {
      $.ui.status('🐸 奶蛙待命 · 敲 /naiwa 叫它')
      return next(e)
    }

    $.ui.status('🐸 奶蛙在岗 · 齁齁齁')
    await offWork($, e, options)
    // 下班彩蛋已经说过话了就不再寒暄
    if ((await read($, line)) === '') await speak($, { occasion: 'greeting' })
    // 宽终端当场落地；窄终端引擎不让它落（见 ensurePane），靠下面 prompt.submit 那次补上
    await ensurePane($)
    return next(e)
  })

  on('command.run', { command: 'naiwa' }, async ($, e, next) => {
    const isOn = !(await read($, isActive))
    await update($, isActive, () => isOn)
    await $.store.set(STORE_ON, isOn)

    if (!isOn) {
      await hush($)
      await $.ui.close({ id: PANE })
      return { text: '🐸 奶蛙：那奶蛙先下班了。开关记住了，下次不会再自己冒出来。' }
    }

    // 你亲手敲的命令 = "asked" 路径，80 列也能落下面板
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
    // 你亲手叫的，不受冷却限制（同 /naiwa-laugh 的 bypass 语义）：把上次开口时间
    // 退回原点。不退的话「关掉又立刻打开」会撞上 8 秒冷却 —— 面板开了，
    // 台词条却是空的（hush 刚清过），看着像坏了。
    await update($, speech, s => ({ ...s, at: 0 }))
    await speak($, { occasion: 'greeting' })
    // 不回 `next(e)`：插件自己注册的命令底下没有核心行为可让，
    // 而且 `next` 的参数必须是合法的 `CommandRunInput`（`args` 是必填的），
    // 拿引擎给的 `e` 原样往回传在测试环境里会直接被拒。直接给结果最省事。
    if (!opened.isPlaced) {
      // 亲手敲的命令是 asked 时机，任何宽度都该落地 —— 走到这儿说明这个会话
      // 压根没有能放面板的表面（比如 `claude -p`）。那就只剩台词条了。
      return { text: `🐸 奶蛙来了（这个会话放不下面板：${opened.reason}）—— 台词条照样陪着。` }
    }
    return { text: '🐸 奶蛙上岗了。齁齁齁，要它下班再敲一次 /naiwa。' }
  })

  on('command.run', { command: 'naiwa-laugh' }, async $ => {
    // 你亲手敲的，不受 /naiwa 开关限制（那个开关管的是「它自己冒不冒出来」）。
    // 台词也得在这里写 —— startLaugh 只管动画，见它的注释。
    await update($, mood, () => MOOD_OF.manual)
    await update($, line, () => fill('manual', '', [], Date.now()))
    await update($, reason, () => reasonOf('manual'))
    await startLaugh($, options)
    return { text: '🐸 奶蛙：哈哈哈哈哈哈哈哈哈哈哈哈哈哈' }
  })

  on('command.run', { command: 'naiwa-talk' }, async $ => {
    const isOn = !(await read($, isDialect))
    await update($, isDialect, () => isOn)
    return isOn
      ? { text: '🐸 奶蛙口吻：开了。齁齁齁，不过技术结论还是照实说。' }
      : { text: '🐸 奶蛙口吻：关了。' }
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
    const said = e.text
    const verdict = occasionOf({ kind: 'prompt', text: said })
    if (verdict !== null) {
      await speak($, { occasion: verdict.occasion, hit: verdict.hit, why: verdict.why, said })
    }
    // 「你发了消息」也是 asked 时机 —— 窄终端里面板唯一落得下来的那一刻。
    // 放在 speak 之后：先让台词就位，面板上来时第一眼看到的就是它要说的话。
    await ensurePane($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')

    const call = occasionOf({ kind: 'bashCall', command })
    if (call !== null) {
      await update($, tally, t => ({ ...t, blocked: t.blocked + 1 }))
      await speak($, { occasion: call.occasion, hit: call.hit, why: call.why })
      $.ui.toast('🐸 奶蛙：这条命令奶蛙给你摁住了')
      return {
        deny: `🐸 奶蛙拦下了这条命令：${describeDanger(command)}。真要跑，请在 Claude Code 之外的终端里自己执行。`,
      }
    }

    await update($, tally, t => ({ ...t, commands: t.commands + 1 }))
    const ran = await next(e)
    const isError = ran.isError === true || /Exit code [1-9]\d*/.test(ran.text ?? '')

    // 连续失败数要在写入前取：`recovered` 判的是「这次成功之前的连挂次数」。
    const before = (await read($, tally)).failStreak
    await update($, tally, t => ({
      ...t,
      failures: t.failures + (isError ? 1 : 0),
      failStreak: isError ? before + 1 : 0,
    }))

    if (ran.deny === undefined) {
      const result = occasionOf({
        kind: 'bashResult',
        command,
        isError,
        text: ran.text ?? '',
        failStreak: before,
      })
      if (result !== null) {
        await speak($, { occasion: result.occasion, hit: result.hit, why: result.why })
        await celebrate($, options, result.occasion)
      }
    }
    return ran
  })

  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const call = occasionOf({ kind: 'writeCall', path: e.file_path })
      if (call !== null) {
        await update($, tally, t => ({ ...t, blocked: t.blocked + 1 }))
        await speak($, { occasion: call.occasion, hit: call.hit, why: call.why })
        return {
          deny: `🐸 奶蛙不让动 ${e.file_path} —— 密钥和凭据文件不进代码、不进 commit。真要改，请你自己来。`,
        }
      }
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        // 编辑成功不开口，只记数 —— 说话太密本身就是上一版的毛病
        await update($, tally, t => ({ ...t, edits: t.edits + 1 }))
      }
      return ran
    })
  }

  on('turn.complete', async ($, e, next) => {
    const verdict = occasionOf({ kind: 'turn', reason: e.reason })
    if (verdict !== null) {
      await speak($, { occasion: verdict.occasion, hit: verdict.hit, why: verdict.why })
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, line)
    if (text === '') return next(e)
    // 心情写进台词条，是因为**面板不一定有地方写字**：80×24 上面板只给 6 行，
    // 正好等于 mini 档的脸，`chooseLayout` 只能给 `lines: 0`。那条路径下面板是
    // 一张脸加零行字，心情永远看不见 —— 台词条不受 `bodyRows` 限制，是窄终端
    // 唯一的出口。这里必须一直显示（包括「平静」），有对照才认得出「失落」。
    const m = await read($, mood)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="#FCDF69">🐸 奶蛙 · {MOOD_NAME[m]}：</Text>
        <Text>{text}</Text>
      </Box>
    )
  })

  // 面板上没有任何可点的东西：心情是奶蛙自己判的，不是你按出来的。
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Raster } = elements
    const [m, text, why, t, laughing] = [
      await read($, mood),
      await read($, line),
      await read($, reason),
      await read($, tally),
      await read($, isLaughing),
    ]

    // 面板能拿几行是引擎说了算（80×24 只给 6 行），而脸有 26 行 —— 不挑档就只剩
    // 头顶一条，看着就是「打开了却没有奶蛙」。挑档规则见 faces.ts。
    const bodyRows = Number(e.props?.scroll?.bodyRows ?? 0)
    const plan = chooseLayout(bodyRows)
    // 播动画时不降档：laugh.bin 固定 44×26，blit 的 cells 跟 Raster 声明的尺寸
    // 对不上会画花。矮终端里动画被裁是意料之中（原来就这样），静态表情才是主路径。
    const tier = laughing ? 'full' : plan.tier
    const grid =
      e.surface === 'terminal' && Raster !== undefined && tier !== null
        ? faceCells((await loadFaces($)) ?? new Uint8Array(), m, tier)
        : null

    // 画不出脸的时候（桌面表面没 Raster、矮到一档都放不下、素材读不出来）
    // 至少留一行自报家门。它占的是脸的位置，不占文字预算。
    const head = grid === null ? [<Text key="name" color="#FCDF69">🐸 奶蛙</Text>] : []

    // 行数不够时**先砍统计，再砍台词** —— 顺序就是这个数组的顺序。
    // 台词排第二不是排在最后：台词条上已经有同一句话了，而「心情 + 判断依据」
    // 是面板独有的信息。80×28 这种只挤得出一行字的终端，该看到的是心情。
    const body = [
      <Text key="mood" dimColor>
        心情：{MOOD_NAME[m]}
        {why === '' ? '' : ` · ${why}`}
      </Text>,
      <Text key="line" color="#FCDF69">
        「{text === '' ? '齁齁齁。' : text}」
      </Text>,
      <Text key="tally" dimColor>
        编辑 {t.edits} · 命令 {t.commands} · 失败 {t.failures} · 拦截 {t.blocked}
      </Text>,
    ].slice(0, plan.lines)

    return (
      <Box flexDirection="column" paddingX={1}>
        {grid === null ? null : (
          <Raster key={FACE_KEY} columns={grid.columns} rows={grid.rows} cells={grid.cells} />
        )}
        {head}
        {body}
      </Box>
    )
  })
}
