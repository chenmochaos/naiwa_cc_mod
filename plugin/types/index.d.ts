/**
 * 奶蛙 mod 的 $.state 契约。
 *
 * 键名 `naiwa` 必须和 plugin.json 的 `name` 一致；`claude plugin validate`
 * 会把模块里读写的每个键都拿这份声明核对 —— 声明了没用到、用到了没声明，
 * 两种都会报。
 */

export type Mood = 'calm' | 'angry' | 'laugh'

export type Tally = {
  edits: number
  commands: number
  failures: number
  blocked: number
  /** 连续失败数，一次成功清零 —— 用来判「连续失败之后又跑通了」。 */
  failStreak: number
}

/**
 * 会话内的说话账本。
 *
 * `at` 是上次开口的时间戳（冷却用），`seq` 是单调序号（LLM 异步补刀回来时
 * 对账，对不上说明已经换过话了，丢掉），`recent` 是最近三句（模板去重）。
 */
export type Speech = {
  at: number
  occasion: string
  seq: number
  recent: readonly string[]
}

declare module 'claude-code' {
  interface PluginState {
    naiwa: {
      /** 面板当前画哪个表情。跟着场合自动切，没有手动入口。 */
      mood: Mood
      /** 台词条上的一句话。空串 = 不说话。 */
      line: string
      /** 面板上「为什么是这个心情」；空串 = 还没判断过。 */
      reason: string
      /** 本次会话的行为计数，只增不减。 */
      tally: Tally
      /** 口吻注入是否打开（system prompt 里那段奶蛙腔）。 */
      isDialect: boolean
      /** 大笑动画是否正在播（防重入标记）。 */
      isLaughing: boolean
      /** /naiwa 在场开关的会话镜像。真源在 $.store 的 'isOn'。 */
      isActive: boolean
      /** 说话账本：冷却、去重、LLM 对账。 */
      speech: Speech
    }
  }
}
