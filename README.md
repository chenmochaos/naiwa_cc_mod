# 奶蛙陪你写代码 🐸

一只ClAUDE CODE桌宠，变异奶龙住进你的终端，陪你上班。根据终端内容变换心情与样式，在你敲 `rm -rf` 的时候一巴掌摁住你的手，在18：00后又一次打开cc时爆笑10s。

![下班大笑彩蛋](docs/demo.gif)

形式为Claude Code ≥ 2.1.287 的**原生插件**（不是第三方框架）。功能形态对齐
[`CocoSgt/yujie-mod`](https://github.com/CocoSgt/yujie-mod)，形象和说话方式是原创角色。

---

## 安装

可以把链接甩给你的cc让你的cc自己来安装。

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
| `/naiwa` | **开关**。打开后奶蛙常驻，每场会话自动出现；再敲一次让它下班（记在 `$.store`，活得过重启） |
| `/naiwa-laugh` | 放完整彩蛋：**103 帧动画 + 原声 + 台词条**，约 10.3 秒 |
| `/naiwa-talk` | 开关奶蛙口吻（会注入 system prompt）。默认**关** |

打开 `/naiwa` 后的面板：像素头像 + 当前台词 + **心情**（平静 / 生气 / 大笑 / 失落）+ **判断依据**。
面板上**没有一个要你点的东西** —— 心情是它自己判的，不是按出来的。

脸按终端给面板多少行分三档：44×26 全身 / 26×15 半身 / 22×6 小脸。140×40 画全身，
80×24 只剩 6 行就换小脸，矮到连小脸都放不下就退成纯文字 —— **面板始终在**。

不敲命令它也会动：

- **台词跟着你说的话走**。你提 `bug` 它就引用 `bug`，你说"上线了"它跟着庆祝。关键时刻
  （开场 / 你不顺 / 你在乐 / 报里程碑）会调一次 LLM 现编一句，失败就静默用本地台词 ——
  不报错、不卡、不瞎编技术判断。
- **心情自己切**。好玩的 → 大笑；命令挂了、测试挂了、你说丧气话 → 失落；拦下危险命令、
  有人要动密钥 → 生气。生气瞪的是那件危险的事，失落陪的是你 —— 挂个测试就冲你瞪眼，那读起来是它在怪你。
- **危险命令拦截**：`rm -rf`、`git push --force/-f`、`git reset --hard`、`git clean -fd`、
  `git branch -D`、`mkfs`、`dd of=/dev/*`、`> /dev/sd*`、fork 炸弹、`chmod -R 777 /` ——
  命中就 deny，命令**根本不交给引擎**，脸和台词一起变生气。
- **密钥保护**：`Edit` / `Write` 碰 `.env`、`.ssh/`、`id_rsa`、`*.pem`、`.netrc`、`credentials.json` 一律 deny。
- **自动彩蛋**：整套测试全绿，或连挂几次之后翻盘 → 放一次大笑动画。
  每场最多 2 次、间隔至少 3 分钟 —— 放太勤就不叫彩蛋了。
- **下班彩蛋**：18:00 之后第一次开交互式会话自动放一次，当天只放一次。

它**不会一直说话**：编辑成功、普通命令成功这些只计数不开口，开口还分三档冷却
（拦截立刻说、失败类 1.5 秒、寒暄类 8 秒）。

---

## 注意事项

### Linux 上音效有坑

`clip` 模式放的是从视频里剪出来的原声（`assets/laugh.mp3`），但它**不走** `$.audio.play` ——
官方文档原话：*a Linux or Windows terminal, having no player, **plays nothing***。
所以 Linux 上插件自己起播放器进程：`paplay` → `ffplay` → 都没有就退回 TTS；macOS 上才走 `$.audio.play`。

TTS 走 `spd-say`（其次 `espeak-ng`、`espeak`），**时长不可控，和 10.3 秒的动画对不齐** ——
要声画同步就用 `clip`。模式在 `/config` 里改，或改 `plugin.json` 的 `userConfig.audio`：
`clip`（默认）/ `tts` / `off`。任何一步失败都吞成静音 —— 彩蛋不该因为没声音就报错。

### 面板什么时候开得出来

**你亲手敲的命令、你发的消息都算 "asked"，任何宽度都落得下面板。** 80 列终端能看到面板全靠这条：
`session.start` 那次开面板没人要求，要 ≥144 列才落得下，所以插件在你发消息时补开一次。

面板能拿多少行是引擎定的，不是插件要的（`$.ui.open({ rows })` 实测无效），
插件读 `scroll.bodyRows` 决定画哪一档脸。面板被关掉时 `ui.blit` 返回 `{ deny }`，插件立刻收摊，不在后台空转。

### `types/` 不在仓库里

`plugin/.claude-plugin/types/` 是从本机 Claude Code 拷出来的类型声明，版权归 Anthropic
（`All rights reserved`），**不随仓库分发**。`validate` 和 `test` 都不需要它，
只有想在编辑器里做 TS 类型检查才要自己拷一份。

### 生成物别手改

`data/faces.bin`、`hooks/face-meta.ts`、`hooks/laugh-meta.ts`、`data/laugh.bin`、`assets/laugh.mp3`
都是**生成物**，改它们 = 改 `tools/` 再重跑：

```bash
python3 tools/build_art.py             # naiwa-images/ + 视频第 270 帧 -> faces.bin + face-meta.ts
python3 tools/build_art.py --preview   # 另出 12 格核对图（改裁剪框后必看）
python3 tools/build_laugh.py           # naiwa-videos/glimpse.mp4 -> laugh.bin + laugh.mp3
```

要 `python3` + `numpy` + `Pillow` + `ffmpeg`。原始素材都在仓库里，流水线能完整重跑；
输出确定，跑完打印 SHA-256。

---

## 开发

```bash
claude plugin validate plugin/   # 清单 + 模块 + $.state 契约
claude plugin test plugin/       # 34 个测试
```

测试覆盖：危险命令与密钥拦截（并确认命令**没被放行**给引擎）、口吻开关、Linux 音效走 `paplay`
而**绝不**调 `$.audio.play`、103 帧动画逐格还原后自停、台词相关性、LLM 四种静默降级、
心情切换、冷却、持久开关、彩蛋门槛、面板分档与 asked 补开。

写测试前先读 `plugin/hooks/register.test.ts` 顶部的注释 —— 那个环境有几条反直觉的规则
（hook 第一个参数是 `$` 不是 `e`；引擎事件返回裸结果、op 事件才包 `{ value }`；同一事件不能 `on` 两次），
不了解会白折腾很久。

设计文档：`docs/superpowers/specs/2026-10-03-naiwa-mod-design.md`
