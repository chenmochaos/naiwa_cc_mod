/**
 * 奶蛙 mod 的 $.state 契约。
 *
 * 键名 `naiwa` 必须和 plugin.json 的 `name` 一致；`claude plugin validate`
 * 会把模块里读写的每个键都拿这份声明核对。
 */

export type Mood = 'calm' | 'angry' | 'laugh'

export type Tally = {
  edits: number
  commands: number
  failures: number
  blocked: number
}

declare module 'claude-code' {
  interface PluginState {
    naiwa: {
      /** 面板当前画哪个表情。 */
      mood: Mood
      /** 台词条上的一句话。 */
      line: string
      /** 本次会话的行为计数，只增不减。 */
      tally: Tally
      /** 口吻注入是否打开（system prompt 里那段奶蛙腔）。 */
      isDialect: boolean
      /** 大笑动画是否正在播（防重入标记）。 */
      isLaughing: boolean
    }
  }
}
