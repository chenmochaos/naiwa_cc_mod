# 奶蛙陪你写代码 🐸

一只变异奶龙住进你的终端。它在你上面那条台词条上齁齁齁，在你敲 `rm -rf` 的时候一巴掌摁住你的手，
在你说"今天先到这"之后笑足十秒。

![下班大笑彩蛋](docs/demo.gif)

Claude Code ≥ 2.1.287 的**原生插件**（不是第三方框架）。功能形态对齐
[`CocoSgt/yujie-mod`](https://github.com/CocoSgt/yujie-mod)，形象和说话方式是原创角色。

---

## 装

插件本体就是 `plugin/` 一个目录。**怎么加载它才是关键** —— Claude Code 有两条通道，只有一条活过重启：

| 通道 | 活多久 |
| --- | --- |
| `claude --plugin-dir <path>` | **只活当前 session**（官方原文 *"for this session only"*） |
| `CLAUDE_CODE_PLUGIN_DIRS` 环境变量 | 每次启动都加载 ✅ |

`~/.claude/dev-mods/<session-id>/` 是 `--plugin-dir` 按 session 落地的目录 —— 往里软链**不是安装**，
下次启动照样没有。

### 持久安装（推荐）

往 `~/.claude/settings.json` 的 `env` 里加一行：

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/绝对路径/到/naiwa_cc_mod/plugin"
  }
}
```

引用而非拷贝：改 `plugin/` 下的源码，重启 `claude` 就生效，不用重装。多个目录用 `:` 分隔。

### 临时试一次

```bash
claude --plugin-dir /绝对路径/到/naiwa_cc_mod/plugin
```

不碰任何配置，关掉就没了。

---

## 功能

| 命令 | 干什么 |
| --- | --- |
| `/naiwa` | 打开奶蛙工位面板：像素头像 + 当前台词 + 编辑/命令/失败/拦截计数 + 两个按钮（大笑 / 换个表情） |
| `/naiwa-laugh` | 播完整彩蛋：**103 帧动画 + 原声配音 + 台词条**同时动，约 10.3 秒 |
| `/naiwa-talk` | 开关奶蛙口吻（会注入 system prompt）。默认**关** |

不用敲命令也会自己动的部分：

- **台词条**（`AbovePrompt` 一行）：每轮提问、每个编辑、每条验证类命令通过时都会换一句。
- **危险命令拦截**：命中就 deny，配生气表情 + toast，命令**根本不会交给引擎**。
  拦 `rm -rf`、`git push --force/-f`、`git reset --hard`、`git clean -fd`、`git branch -D`、`mkfs`、
  `dd of=/dev/*`、`> /dev/sd*`、fork 炸弹、`chmod -R 777 /`。
- **密钥保护**：`Edit` / `Write` 碰 `.env`、`.ssh/`、`id_rsa` 之类、`*.pem`、`.netrc`、`credentials.json` 一律 deny。
- **下班彩蛋**：18:00 之后第一次开交互式会话，自动放一次大笑（音频 + 台词 + toast），当天只放一次。

---

## 注意事项

### Linux 上音效有坑（务必看）

`clip` 模式放的是从视频里剪出来的原声（`assets/laugh.mp3`，10.27 秒，和动画取同一窗口）。
但它**不走** `$.audio.play` —— 官方文档原话：

> `afplay` plays it on macOS, and a Linux or Windows terminal, having no player, **plays nothing**.

所以 Linux 上插件自己找播放器起进程：

| 平台 | clip 模式实际执行 |
| --- | --- |
| macOS | `$.audio.play({ asset })`（afplay） |
| Linux，有 `paplay` | `paplay <插件目录>/assets/laugh.mp3` |
| Linux，有 `ffplay` | `ffplay -nodisp -autoexit -loglevel quiet <...>` |
| Linux，都没有 | 退回 TTS |

TTS 走 `spd-say`（其次 `espeak-ng`、`espeak`），macOS 上是 `$.audio.speak`。
**TTS 念出来的时长不可控，和 10.3 秒的动画对不齐** —— 想要声画同步就用 `clip`。

音效模式在 `/config` 里改，或改 `plugin.json` 的 `userConfig.audio`：
`clip`（默认）/ `tts` / `off`。任何一步失败都被吞成静音 —— **彩蛋不该因为没声音就报错**。

### 终端宽度

- **`/naiwa`、`/naiwa-laugh` 是你主动敲的**（属于 "asked"），80 列也能落下面板。
- **自动触发（下班彩蛋）永远不主动开面板** —— 被动开面板要求 ≥144 列，被开过一次后才降到 110 列，
  80 列的终端落不下。降级成音频 + 台词 + toast，这是 `$.ui.open` 返回 `{ isPlaced: false }` 的正常分支。
- 面板被关掉时 `$.ui.blit` 返回 `{ deny }`，插件立刻 cancel 定时器收摊，不会在后台空转。

### `plugin/.claude-plugin/types/` 不在仓库里

那是从本机 Claude Code 安装目录拷出来的类型声明，版权归 Anthropic（`All rights reserved`），
**不随本仓库分发**。`claude plugin validate` 和 `claude plugin test` 都不需要它；
只有想在编辑器里做 TS 类型检查才需要自己从本机安装拷一份，否则 `plugin/tsconfig.json` 的 `extends` 会指空。

### 生成物别手改

`plugin/hooks/art.ts`、`plugin/hooks/laugh-meta.ts`、`plugin/data/laugh.bin`、`plugin/assets/laugh.mp3`
都是**生成物**，改它们 = 改 `tools/` 再重跑：

```bash
python3 tools/build_art.py      # naiwa-images/ + 视频第 270 帧 -> plugin/hooks/art.ts
python3 tools/build_laugh.py    # naiwa-videos/glimpse.mp4   -> plugin/data/laugh.bin + assets/laugh.mp3
```

需要 `python3` + `numpy` + `Pillow`，以及 `ffmpeg`（解码视频、剪音频）。
原始素材（`naiwa-images/`、`naiwa-videos/`）一并放在仓库里，所以流水线可以完整重跑。
两个脚本输出确定（同样输入跑两遍字节一致），跑完打印 SHA-256；`--preview` 把核对图写进 `_design-preview/`。

---

## 开发

```bash
claude plugin validate plugin/   # 清单 + 模块 + $.state 契约
claude plugin test plugin/       # 13 个测试
```

测试覆盖：危险命令与密钥文件的 deny（并确认命令**没有**被放行给引擎）、口吻开关对 `prompt.compose` 的影响、
Linux 音效真的走 `paplay` 而**绝不**调 `$.audio.play`、103 帧动画播完自停、下班降级路径不试图开面板。

写测试前先读 `plugin/hooks/register.test.ts` 顶部的注释 —— 这个测试环境有两条反直觉的规则
（测试里的 `$` 没有 `fs`/`process`/`clock` 这些名词；op 事件的 hook 第一个参数是 `$` 不是 `e`），
不了解的话会白折腾很久。

设计文档：`docs/superpowers/specs/2026-10-03-naiwa-mod-design.md`
