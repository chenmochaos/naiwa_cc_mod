/**
 * 面板高度 → 画哪一档脸、留几行写字。**纯函数，不碰 `$`**。
 *
 * 和 signals.ts 一个范式：`claude plugin test` 里直接把这张表当数据测，
 * 不用把插件跑起来。
 *
 * **为什么需要它**（这是 v0.3.0 修的 bug 的根因）：面板能拿到几行是引擎说了算，
 * 不是我们要的。实测 ——
 *
 *   80×24 inline → 6 行      80×40 inline → 11 行     80×60 inline → 18 行
 *   140×24 dock  → 16 行     140×40 dock  → 32 行
 *
 * 而全身像是 26 行。只做一个尺寸，面板就被裁成头顶一条 —— 看着就是「没有奶蛙」。
 * 所以素材做了三档（见 tools/build_art.py），这里按实际行数挑最大的放得下的那档。
 */

import { FACE_TIER_NAMES, FACE_TIER_SLOTS } from './face-meta'
import type { FaceTierName } from './face-meta'

/** 面板上文字最多占三行：台词 / 心情+依据 / 统计。 */
export const MAX_TEXT_ROWS = 3

export type FacePlan = {
  /** `null` = 一档脸都放不下，只能纯文字面板（但面板仍然在，不是空白）。 */
  tier: FaceTierName | null
  /** 图上文字画几行（0 ~ MAX_TEXT_ROWS）。 */
  lines: number
}

/**
 * 拿不到 `bodyRows` 时按这一档走：mini 脸 + 三行字 = 9 行。
 *
 * 取最保守值而不是「假设宽敞」：80×24 的面板只有 6 行，9 行的内容会被切掉
 * 最后一行统计 —— 但**脸完整**。反过来按 32 行假设，脸会被裁成一条，
 * 那正是这次要修的 bug。宁可少一行字，不可少一张脸。
 */
const UNKNOWN_ROWS: FacePlan = { tier: 'mini', lines: MAX_TEXT_ROWS }

/**
 * 挑档位。两轮：
 *
 *  1. **优先「脸 + 至少一行台词」** —— 台词是这个插件的主体，脸再大也是配菜。
 *     26 行的终端里给 full（26 行）会把三行字全挤掉，那不如 mid + 三行字。
 *  2. 一档都塞不下字了，就只画脸 —— 面板里看得见奶蛙比有字重要。
 *  3. 连脸都放不下 → `tier: null`，纯文字。矮终端也仍然有面板。
 */
export function chooseLayout(bodyRows: number): FacePlan {
  if (!Number.isFinite(bodyRows) || bodyRows <= 0) return UNKNOWN_ROWS
  const budget = Math.floor(bodyRows)

  for (const tier of FACE_TIER_NAMES) {
    const { rows } = FACE_TIER_SLOTS[tier]
    if (budget >= rows + 1) return { tier, lines: Math.min(MAX_TEXT_ROWS, budget - rows) }
  }
  for (const tier of FACE_TIER_NAMES) {
    const { rows } = FACE_TIER_SLOTS[tier]
    if (budget >= rows) return { tier, lines: 0 }
  }
  return { tier: null, lines: Math.min(MAX_TEXT_ROWS, budget) }
}
