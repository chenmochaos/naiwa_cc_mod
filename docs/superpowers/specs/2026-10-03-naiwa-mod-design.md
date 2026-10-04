# 奶蛙 Mod 设计文档

日期：2026-10-03
状态：已批准，实施中

## 目标

复刻 `CocoSgt/yujie-mod` 的功能形态，角色换成原创的**奶蛙**：终端里的像素形象 + 台词 + 危险命令拦截 + 说话风格注入 + 一个"下班大笑"彩蛋。

对齐而非照抄：雨姐是东北大姐口音，奶蛙是"可爱里掺鬼畜"的抽象梗角色，两者共用同一套 API 骨架。

## 角色

来源 `naiwa.md`：奶蛙是变异奶龙，AI 生成，气质抽象、癫狂、荒诞，招牌笑声「齁齁齁」。
主色 `#FCDF69`。最经典形象是捧腹大笑（`naiwa-videos/glimpse.mp4`）。

台词库分四类（`plugin/hooks/lines.ts`）：

| mood | 场景 | 语气样例 |
| --- | --- | --- |
| `calm` | 提交提问、日常 | "齁齁齁，让奶蛙看看"、"别急，奶蛙在加载笑声" |
| `laugh` | 编辑成功、回合完成、彩蛋 | "哈哈哈哈哈哈哈哈"、"嘎嘎滴辣虾"、"笑死，这 bug 自己走了" |
| `angry` | 拦截危险命令、命令报错 | "哎呦我去，这条命令奶蛙给你摁住了"、"想删库？奶蛙不同意" |

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

| 事件 | 行为 |
| --- | --- |
| `session.start` | 注册 `/naiwa` `/naiwa-laugh` `/naiwa-talk`；探测平台；状态行；**不主动开面板**；下班时间到则放降级彩蛋 |
| `command.run` `/naiwa` | 开面板 |
| `command.run` `/naiwa-laugh` | 播完整彩蛋（面板 + 动画 + 音频 + 台词） |
| `command.run` `/naiwa-talk` | 开关口吻模式，`$.ui.invalidate('prompt.compose')` |
| `prompt.compose` | 口吻模式开 → 追加 `{id:'naiwa:dialect', text:DIALECT, scope:'session'}` |
| `prompt.submit` | 随机 calm 台词 |
| `tool.call` `Bash` | `DANGER` 正则命中 → angry + `{deny}`（不调 next）；否则 `await next(e)` 并按 `isError`/输出判失败 |
| `tool.call` `Edit`/`Write` | 计数；成功则 laugh 台词 |
| `turn.complete` | `reason === 'answer'` 时庆祝 |
| `ui.render` `AbovePrompt` | 台词条：`🐸 奶蛙：<台词>` |
| `ui.render` `Pane` | 头像 Raster（非 terminal surface 回退文字）+ 台词 + 统计 + 两个按钮 |

### 大笑彩蛋

用户主动（`/naiwa-laugh`）→ 开面板（属 "asked"，80 列也能落）→ 音频与动画并行 → 103 帧 `$.ui.blit` 播完自停。

**下班触发**（本地时间 ≥18:00 的首次 session，`$.store` 记日期保证每天一次）→ **降级版**：
只放音频 + 台词条 + toast，不尝试开面板。原因见下。

### 平台与宽度约束（已核实）

1. `$.audio.play({asset})` **在 Linux 上不播任何东西**（文档：afplay 仅 macOS）。Linux 走 `$.process.run(['paplay', ...])`。
2. `$.audio.speak` 是 macOS 的 `say`；Linux 退路 `spd-say`。
3. 被动开面板需 ≥144 列（被开过一次后 110 列），本机终端 **80 列** → 自动触发落不下面板；
   `$.ui.blit` 在 Raster 未挂载时返回 `{ deny }` → 自动触发也放不了动画。

配置项 `audio`（`clip` / `tts` / `off`，默认 `clip`）走 `plugin.json` 的 `userConfig`，`/config` 里可切换。

## 测试与验收

自动：
- `claude plugin validate plugin/`
- `claude plugin test plugin/` —— `register.test.ts` 覆盖危险命令拦截、口吻 section 追加、Bash 计数、
  `audio: 'off'` 时零音频调用
- 引擎加载后 `tsc -p plugin/`

真机（需实拍证据）：
1. `/naiwa` 开面板，三个表情都显示、脸可辨认
2. `/naiwa-laugh` —— **动画 + 音频 + 台词条同时动**
3. `rm -rf` 类命令被拦 + angry 表情 + toast
4. `/naiwa-talk` 开关后 system prompt 确实变了
5. 下班降级路径：面板落不下时，音频与台词条照常
6. `wc -c plugin/data/laugh.bin` = 235664；`ffprobe assets/laugh.mp3` ≈ 10.27s
7. Kubuntu 上音频实测出声
