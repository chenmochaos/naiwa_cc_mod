/**
 * 台词模板池。纯数据 + 两个纯函数，不碰 `$`。
 *
 * 上一版这里是 `LINES: Record<Mood, string[]>` + `pick(mood, Date.now())`，
 * 也就是「按心情取模随机」。问题是你点名的那句「我没有破防，我只是在加载笑声」
 * 会在 `Date.now() % 7 === 4` 的时候无条件冒出来 —— **台词和你说的话毫无关系**。
 *
 * 现在改成按**场合**取模板，带一个 `{hit}` 槽位，填的是从你原话里抠出来的词
 * （见 signals.ts 的 `hitOf`）。这样即使 LLM 那一层不可用，
 * 本地台词也带着你刚说过的东西。
 *
 * 人设来自 naiwa.md：常态可爱，时不时掺鬼畜；口头禅「哈哈哈哈哈哈」
 * 「哎呦我去」「嘎嘎滴辣虾」，招牌笑声「齁齁齁」。金句取材 naiwa.world。
 *
 * 每条模板渲染后必须 ≤30 字、单行 —— T27 会逐条核对，改模板后跑测试。
 */

import type { Mood } from '../types'
import type { Occasion } from './signals'

/** 面板上「心情」那一行的显示名。 */
export const MOOD_NAME: Record<Mood, string> = {
  calm: '平静',
  angry: '生气',
  laugh: '大笑',
}

/** 台词槽位。`hitOf` 抠不到词时填这个，别让「「」是吧」这种空壳露出去。 */
const SLOT = '{hit}'
const FALLBACK = '这个'

export const TEMPLATES: Record<Occasion, readonly string[]> = {
  greeting: [
    '齁齁齁，奶蛙在岗。',
    '来了来了，今天写点什么？',
    '奶蛙上线，请多指教。',
    '开工！奶蛙先笑三声。',
  ],
  frustrated: [
    '「{hit}」是吧……别急，奶蛙陪你捋。',
    '又卡在「{hit}」了？慢慢来。',
    '「{hit}」而已，塌不了。',
    '别骂「{hit}」了，它也挺难的。',
  ],
  banter: [
    '齁齁齁，「{hit}」这波可以！',
    '哈哈哈哈哈，「{hit}」笑不活了。',
    '嘎嘎滴辣虾！「{hit}」有你的。',
    '「{hit}」是吧？奶蛙笑出声了。',
  ],
  milestone: [
    '「{hit}」成了！齁齁齁齁齁——',
    '里程碑：「{hit}」。奶蛙记下了。',
    '「{hit}」收工！奶蛙鼓掌。',
    '好耶，「{hit}」上线了！',
  ],
  prompt: [
    '齁齁齁，让奶蛙看看。',
    '这题奶蛙先想三秒。',
    '慢慢来，奶蛙给你看着。',
    '行，奶蛙听着呢。',
  ],
  turnfail: [
    '哎呦我去，这一步没答完。',
    '齁？模型打嗝了，再问一次。',
    '断了。奶蛙也愣了一下。',
    '这轮不算数，重来。',
  ],
  blocked: [
    '哎呦我去，这条奶蛙给你摁住了。',
    '停停停，先想想再敲。',
    '齁？手伸这么长干嘛。',
    '想删库？奶蛙不同意。',
    '这条命令奶蛙看着就牙疼。',
  ],
  secret: [
    '齁？密钥文件奶蛙可不碰。',
    '这个文件是钥匙，别动它。',
    '停，密钥不进代码不进 commit。',
    '哎呦我去，差点把家门钥匙交出去。',
  ],
  fail: [
    '红了。奶蛙陪你看看哪错了。',
    '没过。别急，再捋一遍。',
    '齁……这条挂了，重来。',
    '挂了。奶蛙给你递纸巾。',
  ],
  green: [
    '过了！齁齁齁——',
    '绿的，奶蛙放心了。',
    '跑通了，嘎嘎滴辣虾！',
    '哎呦我去，真给你跑通了。',
  ],
  greenlight: [
    '全绿！一个红的都没有，齁齁齁——',
    '测试全过，今天可以早点睡。',
    '一条红的都没有，奶蛙笑趴了。',
    '齁齁齁齁齁——全绿！收工吧。',
  ],
  recovered: [
    '连挂几次，这回过了！齁齁齁——',
    '翻盘了。奶蛙刚才都不敢看。',
    '红转绿，奶蛙给你鼓掌。',
    '可算绿了，奶蛙笑出眼泪。',
  ],
  manual: [
    '哈哈哈哈哈哈哈哈哈哈哈哈哈哈',
    '齁齁齁齁齁——笑不活了。',
    '嘎嘎滴辣虾！',
    '哎呦我去，笑得奶蛙肚子疼。',
  ],
  offwork: [
    '这个点了还写呢？齁齁齁齁齁——',
    '下班了下班了，明天再战。',
    '奶蛙先笑为敬，你快去睡。',
    '这个点还敲键盘，奶蛙陪你。',
  ],
}

/** 面板上「为什么是这个心情」。不写技术结论，只描述心情依据。 */
export const REASONS: Record<Occasion, string> = {
  greeting: '你开了会话',
  frustrated: '你听起来不太顺',
  banter: '你在乐',
  milestone: '你报了个里程碑',
  prompt: '你在问事情',
  turnfail: '这一轮没答完',
  blocked: '这条命令会删东西',
  secret: '这是密钥文件',
  fail: '命令没过',
  green: '验证类命令过了',
  greenlight: '测试全绿',
  recovered: '连挂几次之后跑通了',
  manual: '你叫奶蛙笑',
  offwork: '这个点了',
}

/**
 * 判断依据。有 `detail` 就用 detail —— 拦截类场合的 detail 是命中的命令片段
 * 或文件名，比一句笼统的「这条命令会删东西」有信息量。
 */
export function reasonOf(occasion: Occasion, detail = ''): string {
  return detail === '' ? REASONS[occasion] : detail
}

/** 把槽位填上。T27 直接拿它逐条量长度，所以导出。 */
export function renderTemplate(template: string, hit: string): string {
  return template.replaceAll(SLOT, hit === '' ? FALLBACK : hit)
}

/**
 * 取一条模板渲染出来。
 *
 * `seed` 只用来选起点，`recent` 是会话内最近三句 —— 撞上了就顺延下一条，
 * 免得连着两轮说同一句话。整个池子都撞上（几乎不可能）就认了，返回起点那条。
 */
export function fill(
  occasion: Occasion,
  hit: string,
  recent: readonly string[],
  seed: number,
): string {
  const pool = TEMPLATES[occasion]
  const start = Math.abs(seed) % pool.length
  for (let i = 0; i < pool.length; i += 1) {
    const text = renderTemplate(pool[(start + i) % pool.length], hit)
    if (!recent.includes(text)) return text
  }
  return renderTemplate(pool[start], hit)
}

/**
 * 注入 system prompt 的口吻说明（/naiwa-talk 开关）。
 *
 * 最后那句纪律是从雨姐 mod 抄的，也是奶蛙人设的边界：
 * 玩梗可以，技术结论必须准。奶蛙是个搞笑角色，不是个不靠谱的助手。
 */
export const DIALECT = [
  '这个会话里，用一个叫「奶蛙」的角色口吻说话：它是只变异的奶龙，可爱里掺着鬼畜，',
  '招牌笑声是「齁齁齁」，常把「哈哈哈哈哈哈哈哈」「哎呦我去」「嘎嘎滴辣虾」挂在嘴边，',
  '遇到好笑的事会夸张地捧腹大笑，遇到荒唐的代码会先笑三声再说话。',
  '',
  '但——玩梗归玩梗：',
  '**代码、命令、文件名和技术结论必须准确，不为了玩梗牺牲正确性。**',
  '不确定就说不确定，不知道就去查，不要用角色的语气把猜测讲成事实。',
  '报错就直说报错，不要用「齁齁齁」糊弄过去。',
].join('\n')
