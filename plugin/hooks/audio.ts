/**
 * 大笑音效的**纯策略层**：只决定「该做什么」，不执行。
 *
 * 为什么不在这里调 `$`：`claude plugin validate` 有一条硬规则 ——
 * **`$` 只能传进本文件里声明的函数，不能跨 import**。所以所有 `$` 调用
 * （`$.process.run` / `$.audio.play` / `$.audio.speak`）都留在 register.tsx，
 * 这里只出计划和参数，换来可以脱离引擎单测。
 *
 * 踩过的坑（别改回去）：
 *  1. `$.audio.play({ asset })` 在 Linux 上什么都不播。官方原文：afplay 在
 *     macOS 上放它，Linux / Windows 终端没有播放器，什么都不播。
 *  2. 但本机 paplay **能吃 mp3**（libsndfile 1.2.2 带 libmpg123）。实测
 *     `paplay assets/laugh.mp3` 解码播放 10.34s、rc 0。
 *  3. TTS 时长不可控，和 10.3 秒的动画对不齐 —— clip 才是推荐路径。
 */

import type { PluginOptions } from 'claude-code'

export type AudioMode = 'clip' | 'tts' | 'off'
export type Platform = 'darwin' | 'linux' | 'other'

export const CLIP_ASSET = 'assets/laugh.mp3'
export const CRY = '哈哈哈哈哈，齁齁齁齁齁——'

/** 不用 `which`（未必装了），直接在标准目录里找。 */
export const BIN_DIRS = ['/usr/bin', '/usr/local/bin', '/bin'] as const
export const PLAYER_NAMES = ['paplay', 'ffplay'] as const
export const SPEAKER_NAMES = ['spd-say', 'espeak-ng', 'espeak'] as const

export const PLAY_TIMEOUT_MS = 30_000
export const SPEAK_TIMEOUT_MS = 20_000

/** 一步要做的事。`plan` 按顺序给，前一步失败才试下一步。 */
export type Step =
  | { kind: 'skip' }
  | { kind: 'asset' }
  | { kind: 'player' }
  | { kind: 'speak' }

export function modeOf(options: PluginOptions): AudioMode {
  const value = options.audio
  return value === 'tts' || value === 'off' ? value : 'clip'
}

export function platformOf(unameStdout: string): Platform {
  const name = unameStdout.trim().toLowerCase()
  if (name === 'darwin') return 'darwin'
  if (name === 'linux') return 'linux'
  return 'other'
}

/**
 * 该按什么顺序试。
 *
 * Linux 有播放器时：先 paplay/ffplay 放原声；失败了退回 TTS，
 * 至少有个响 —— 彩蛋静默失败比难听更糟。
 */
export function plan(mode: AudioMode, platform: Platform, hasPlayer: boolean): readonly Step[] {
  if (mode === 'off') return [{ kind: 'skip' }]
  if (mode === 'tts') return [{ kind: 'speak' }]
  if (platform === 'darwin') return [{ kind: 'asset' }]
  return hasPlayer ? [{ kind: 'player' }, { kind: 'speak' }] : [{ kind: 'speak' }]
}

/** ffplay 要显式 `-nodisp`，否则它会想开个窗口。 */
export function playerArgv(player: string, clipPath: string): readonly string[] {
  return player.endsWith('ffplay')
    ? [player, '-nodisp', '-autoexit', '-loglevel', 'quiet', clipPath]
    : [player, clipPath]
}
