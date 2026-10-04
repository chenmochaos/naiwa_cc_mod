# 奶蛙 Mod 设计文档

日期：2026-10-03（v0.2 修订 2026-10-04）
状态：v0.1 已交付；v0.2 已实施

## v0.2 变更摘要

v0.1 真机用下来暴露三个问题，根因是同一个：**奶蛙是「被动等触发 + 随机抽台词」，读不懂语境**。

| v0.1 | v0.2 |
| --- | --- |
| `pick(mood, Date.now())` 取模随机，台词和你说的话无关 | 场合判定（`signals.ts`）→ 场合模板池（带 `{hit}` 槽位）→ 关键时刻再调 LLM 补一句 |
| 几乎每个事件都换一句，话太密 | 大多数事件**根本不开口**，只记数；开口分 `urgent`/`notable`/`normal` 三档冷却 |
| `/naiwa` 只是「开一次面板」，无状态 | `/naiwa` 是**持久开关**（`$.store`），打开后每场会话自动在场 |
| 拦截危险命令时只换台词不换心情 | 心情**永远跟着场合走**，拦截时脸和台词一起变生气 |
| 面板上有「换个表情」「大笑」两个按钮 | 面板上**没有任何可点的东西**，只显示心情 + 判断依据 + 计数 |
| 彩蛋只由 `/naiwa-laugh` 触发 | 测试全绿 / 连挂后翻盘 → **自动**放彩蛋（每会话 ≤2 次、间隔 ≥3 分钟） |

## 目标

复刻 `CocoSgt/yujie-mod` 的功能形态，角色换成原创的**奶蛙**：终端里的像素形象 + 台词 + 危险命令拦截 + 说话风格注入 + 一个"下班大笑"彩蛋。

对齐而非照抄：雨姐是东北大姐口音，奶蛙是"可爱里掺鬼畜"的抽象梗角色，两者共用同一套 API 骨架。

## 角色

来源 `naiwa.md`：奶蛙是变异奶龙，AI 生成，气质抽象、癫狂、荒诞，招牌笑声「齁齁齁」。
主色 `#FCDF69`。最经典形象是捧腹大笑（`naiwa-videos/glimpse.mp4`）。

台词按**场合**组织，不按心情组织（`plugin/hooks/lines.ts` 的 `TEMPLATES`，14 个场合 × 4-5 条）。

关键设计是 `{hit}` 槽位：从你原话里抠一个词（文件路径 / 引号里的词 / `bug`、`报错` 这类关键词）
填进去。所以哪怕 LLM 那一层整个不可用，屏幕上的台词也带着你刚说过的东西 ——
上一版那句被投诉的「我没有破防，我只是在加载笑声」就是**没有任何输入**的产物，已删除。

| 心情 | 场合 | 语气样例 |
| --- | --- | --- |
| `calm` | `greeting` `frustrated` `prompt` | "齁齁齁，奶蛙在岗。"、"「{hit}」是吧……别急，奶蛙陪你捋。" |
| `laugh` | `banter` `milestone` `green` `greenlight` `recovered` `manual` `offwork` | "齁齁齁，「{hit}」这波可以！"、"全绿！一个红的都没有，齁齁齁——" |
| `angry` | `turnfail` `blocked` `secret` `fail` | "哎呦我去，这条奶蛙给你摁住了。"、"红了。奶蛙陪你看看哪错了。" |

每条模板渲染后必须 ≤30 字、单行（T27 逐条核对）。另有一张 `REASONS` 表给面板显示判断依据。

外加 `DIALECT`：一段注入 system prompt 的口吻说明，末尾强制一句
**「代码、命令、文件名和技术结论必须准确，不为了玩梗牺牲正确性」**。

## 视觉

像素画，**44 列 × 26 行**终端格 = 44×52 像素。一格画两像素行（`▀` 上半块，前景=上像素，背景=下像素）。

三个表情，全部**抓头构图**（面部优先，不看全身）：

| mood | 来源 | 裁剪框（占主体比例） |
| --- | --- | --- |
| `calm` | `平静可爱.jpg` | `(0.16, 0.00, 0.81, 0.61)` |
| `angry` | `生气凝视.jpg` | `(0.16, 0.00, 0.52, 0.20)` |
| `laugh` | 视频第 270 帧 | 主体上半 66% |

裁剪框是**人工标注**的，不是自动检测 —— 自动暗部检测会抓到深色手部和阴影，试过两轮都失败。
雨姐的美术也是手工做的，这一步是正当的作者工作。

不做 `sad`：`伤心失落.jpg` 和 `大笑.jpg` 都是 3/4 背身、看不到脸，四组更紧的框都救不回来。

配色用 **11 色固定色板**（从参考图取样），不用自适应中位切分 —— 后者在柔和 3D 渐变上会造出橄榄/粉色脏块。

## 动画

103 帧 / 10fps / 约 10.3 秒，源自视频第 **48–356** 帧（每 3 帧取 1）。

**跟头构图**：逐帧算主体 bbox → 头部窗口 = 主体高 62%，水平锚点 = `0.5×主体中心 + 0.5×暗部（眼/嘴）质心`
→ **9 帧滑动平均**平滑，镜头平移而不是跳。

第 396 帧之后是"笑到倒地"。横躺构图在 44×26 里必然糊（脸变俯视、身形变横），**砍掉**。

不循环，一次播完（用户选定"完整叙事一次播完"）。

音频 `assets/laugh.mp3` 与动画取同一窗口（`ffmpeg -ss 1.60 -t 10.27`），保证声画同步起点。

数据以 `data/laugh.bin` 交付：103 × 44 × 52 字节，每字节一个调色板索引，`255` = 透明。
用二进制而非内联进 `.ts`，是因为内联要 1MB+；二进制 235KB，`$.fs.read` 读一次缓存，零解压依赖。

## 行为

编排只有一条路径：**事件 → `occasionOf()` 判场合 → `MOOD_OF`/`REASONS`/`PRIORITY_OF` 查表
→ `shouldSpeak()` 过冷却 → `fill()` 抽一条模板 → 写 `mood`/`line`/`reason` 三个 atom**。
判场合、查表、过冷却、抽模板全是 `signals.ts`/`lines.ts` 里的纯函数，不碰 `$`，所以整张判定表能直接当数据测。

| 事件 | 场合 | 心情 | 优先 | 机制 |
| --- | --- | --- | --- | --- |
| `session.start`（开关开） | `greeting` | calm | normal | **LLM**→本地；清空说话账本；下班时间到则先放降级彩蛋 |
| `prompt.submit` 负面 | `frustrated` | calm | notable | **LLM**→本地，槽位带你的词 |
| `prompt.submit` 玩梗 | `banter` | laugh | notable | **LLM**→本地 |
| `prompt.submit` 里程碑 | `milestone` | laugh | normal | **LLM**→本地 |
| `prompt.submit` 普通 | `prompt` | calm | normal | 本地 |
| `turn.complete` error/aborted | `turnfail` | angry | notable | 本地 |
| `tool.call` `Bash` 命中 `DANGER` | `blocked` | **angry** | **urgent** | `{deny}`，不调 next |
| `tool.call` `Edit`/`Write` 命中 `PROTECTED` | `secret` | **angry** | **urgent** | `{deny}` |
| `tool.call` `Bash` 失败 | `fail` | angry | notable | 本地；`failStreak++` |
| 验证类命令成功 | `green` | laugh | notable | 本地 |
| **测试运行器全绿** | `greenlight` | laugh | notable | 本地 + **自动彩蛋** |
| **连挂 ≥2 次后跑通** | `recovered` | laugh | notable | 本地 + **自动彩蛋**，依据带次数 |
| 编辑成功、普通命令成功 | — | — | — | **沉默**，只记数 |
| `command.run` `/naiwa` | 开→`greeting` | — | bypass | 持久开关，见下 |
| `command.run` `/naiwa-laugh` | `manual` | laugh | bypass | 播完整彩蛋（面板 + 动画 + 音频 + 台词） |
| `command.run` `/naiwa-talk` | — | — | — | 开关口吻模式，`$.ui.invalidate('prompt.compose')` |
| `prompt.compose` | — | — | — | 口吻模式开 → 追加 `{id:'naiwa:dialect', text:DIALECT, scope:'session'}` |
| 18:00 后首次会话 | `offwork` | laugh | bypass | 音频 + 台词 + toast（降级，不开面板） |
| `ui.render` `AbovePrompt` | — | — | — | 台词条：`🐸 奶蛙：<台词>`；台词为空时不画 |
| `ui.render` `Pane` | — | — | — | 头像 Raster（非 terminal surface 回退文字）+ 台词 + 心情 + 判断依据 + 计数，**无按钮** |

**四条实现纪律**（每条都踩过）：

1. **`urgent` 场合一次都不读时钟。** 拦截必须无条件开口，本来也不该被冷却压住；
   而且拦截路径在测试里没有 `mock.clock`，一读就是 "no implementation"。
2. **心情永远跟着场合走。** v0.1 的 `say($, mood, force=true)` 是个双关参数，
   它只换台词不换心情，于是拦下危险命令时脸还是 `calm`。v0.2 把 `force` 整个删掉。
3. **缓存值变化不触发重绘**，`$.store` / atom 都要显式写回 atom。
4. **`$` 不能跨 import**（`audio.ts` 文件头记录的 validate 硬规则），所以
   `$.model.complete` / `$.session.model` 必须字面写在 `register.tsx`，`gen.ts` 只出「该请求什么」。

### `/naiwa` 持久开关

store key `isOn`（boolean，默认 `false`），跨会话、跨重启。会话内镜像进 `isActive` atom 才能让面板刷新。

- **打开**：`$.ui.open`（你亲手敲的命令 = "asked" 路径，80 列也能落）+ 出 `greeting` 台词 + 状态行。
- **关闭**：`$.ui.close` + `hush()`（清空 `line`/`reason`/心情/动画定时器）+ 状态行改回待命。
- **每场会话开头都先清空说话账本再 `hush()`**：atom 活得过同一进程里的下一场会话，
  不清的话上一场的冷却会压掉开场寒暄，上一场留在屏幕上的台词也会跨会话显示。
- 开关**只门控「说话 / 表情」**，绝不门控 `DANGER`/`PROTECTED` 拦截和计数 ——
  拦危险命令是安全底线，不该因为你把陪伴关了就不拦。

### LLM 台词生成（`plugin/hooks/gen.ts`）

只有 4 个场合值得花一次调用：`greeting` / `frustrated` / `banter` / `milestone`。
每会话上限 **3 次**、两次最小间隔 **15s**。

**永远是「先本地渲染、后异步补刀」**：本地模板立刻上屏，LLM 结果回来了再替换。
一次调用实测 1.1–5.6 秒，延迟绝不落在热路径上。

失败一律静默降级（`api-error` / `empty-reply` / 超时 / 抛异常 / `sanitize` 拒绝 / 序号对不上），
本地台词已经在屏幕上，用户看不到任何异常。

| 参数 | 值 | 理由 |
| --- | --- | --- |
| `model` | `await $.session.model()` | 跟你 `/model` 里在用的一致，不会出现「插件偷偷用了另一个模型」 |
| `effort` | `'low'` | 一句俏皮话不需要深思 |
| `timeoutMs` | `8000` | 超时 resolve 成 `aborted`，不 reject |
| `signal` | 每次新建 `AbortController` | 新调用 abort 旧的 |
| `maxTokens` | `48` | **实测网关不认**（传 8 回来 output_tokens 84），保留只为表达意图 |

所以**唯一的 brevity 闸门是 `sanitize()` 的长度检查**，不是锦上添花：

- 只取第一行 → 剥 markdown 装饰 / emoji / 引号 → 长度 >30 直接丢；
- 命中禁用词（` ``` `/`rm`/`Exit code`/`/dev/`/`.env`/`.pem`/「报错」「建议」「应该」「试试」/ 斜杠）直接丢。
- **先查禁用词再剥装饰** —— 反过来的话 ` ``` ` 会被剥成空串，于是「模型输出了代码块」
  变成「模型什么都没说」，看起来像降级成功。

system prompt 三重保险：LLM 只产情绪台词（明确禁止技术判断）；`sanitize` 再挡代码/路径/报错词；
LLM 文本**永不进入 `reason`、永不参与判定、永不改计数**。

### 大笑彩蛋

用户主动（`/naiwa-laugh`）→ 开面板（属 "asked"，80 列也能落）→ 音频与动画并行 → 103 帧 `$.ui.blit` 播完自停。

**高光自动触发**（`greenlight` / `recovered`）→ 每会话 ≤2 次、两次间隔 ≥3 分钟。
门槛刻意定得比 `VERIFY` 窄得多：只有**整套测试运行器**全绿才算高光，`build`/`lint` 通过只是「顺」。
`startLaugh` 只驱动动画和音频，**不写 `line`/`reason`** —— 否则彩蛋会把「连挂 2 次后跑通」
这个判断依据冲掉，面板上就再也看不到它为什么笑。

**下班触发**（本地时间 ≥18:00 的首次 session，`$.store` 记日期保证每天一次）→ **降级版**：
只放音频 + 台词条 + toast，不尝试开面板。原因见下。

### 平台与宽度约束（已核实）

1. `$.audio.play({asset})` **在 Linux 上不播任何东西**（文档：afplay 仅 macOS）。Linux 走 `$.process.run(['paplay', ...])`。
2. `$.audio.speak` 是 macOS 的 `say`；Linux 退路 `spd-say`。
3. 被动开面板需 ≥144 列（被开过一次后 110 列），本机终端 **80 列** → 自动触发落不下面板；
   `$.ui.blit` 在 Raster 未挂载时返回 `{ deny }` → 自动触发也放不了动画。

配置项 `audio`（`clip` / `tts` / `off`，默认 `clip`）走 `plugin.json` 的 `userConfig`，`/config` 里可切换。

## state 契约（`plugin/types/index.d.ts`）

```
naiwa: { mood, line, reason, tally, isDialect, isLaughing, isActive, speech }
```

`tally` 是计数（编辑 / 命令 / 失败 / 拦截 + `failStreak` 连续失败数，一次成功清零）；
`speech` 是会话内的说话账本（上次开口时间、场合、单调序号、最近 3 句）。
`validate` 双向核对：声明的每个键都被用到、用到的每个键都声明。

`speech.seq` 是 LLM 对账用的：异步补刀回来时比对序号，这期间又开过口就把旧回复丢掉，
避免「旧话盖新反应」。`speech.occasion` 存 `string` 而非 `Occasion`，避免 `types` ↔ `signals` 循环依赖。

## 测试与验收

自动（改完必须全跑，不要只改不验）：

- `claude plugin validate plugin/` —— 清单 + 模块 + `$.state` 契约
- `claude plugin test plugin/` —— 30 条：危险命令/密钥拦截、口吻 section、Bash 计数与彩蛋、
  `audio: 'off'` 零音频调用、103 帧 blit 逐格还原、LLM 补刀与四种静默降级、
  台词相关性、心情随场合切换、冷却、持久开关、面板无按钮、判定表与模板长度
- `cd /tmp && claude -p --debug-file /tmp/naiwa-load.log "ok"` 然后 grep
  `hooks module naiwa@inline loaded`（期望 1）与 `Found N plugins`（期望 9）

**测试环境的两条反直觉规则**（写测试前先看 `register.test.ts` 文件头）：

- 测试体里的 `$` 只有驱动用的名词，**没有** `fs`/`process`/`clock`/`store`/`state`；
- **引擎事件返回裸结果，op 事件（`$.noun.verb`）才返回 `{ value }`**。
  `prompt.submit` / `ui.render` / `prompt.compose` / `session.start` 都是引擎事件，包一层 `{ value }` 会被拒。
- 同一个事件不能 `on` 两次；所有 `on(...)` 必须在第一次碰 `$` 之前注册完。

真机（需实拍证据）：
1. `/naiwa` → 面板立刻出现、**没有任何按钮**，显示心情 + 判断依据 + 计数
2. 说「我今天写的全是 bug」→ 台词条引用 `bug`；有网时几秒内换成生成台词；
   **断网再试 → 依旧有本地台词、不报错、不卡**
3. `rm -rf build` 被拦 + **脸变生气**（不是只有台词变）+ 依据显示 `rm` —— 本次核心验收
4. 跑真测试套件且全绿 → 自动彩蛋；80 列下面板落不下时音频 + 台词条照常
5. 关终端重开会话 → 面板自动回来（持久）；再敲 `/naiwa` → 面板关、台词条清空
6. `/naiwa-laugh` 手动彩蛋仍可播
7. `/naiwa-talk` 开关后 system prompt 确实变了
8. 下班降级路径：面板落不下时，音频与台词条照常
9. `wc -c plugin/data/laugh.bin` = 235664；`ffprobe assets/laugh.mp3` ≈ 10.27s
10. Kubuntu 上音频实测出声
