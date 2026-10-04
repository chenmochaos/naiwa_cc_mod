# naiwa_cc_mod

奶蛙（Naiwa）陪你写代码 —— 一个 Claude Code mod。功能对齐 [`CocoSgt/yujie-mod`](https://github.com/CocoSgt/yujie-mod)，形象与说话方式换成原创角色奶蛙。

## 这是什么

Claude Code ≥ 2.1.287 的原生插件（不是第三方框架）。它在终端里给模型加一层人设：
台词条、表情面板、危险命令拦截、说话风格注入 system prompt、以及一个"下班大笑"彩蛋。

## 目录约定

| 目录 | 放什么 | 规则 |
| --- | --- | --- |
| `plugin/` | **插件本体，唯一的交付物** | 这里的内容必须自洽：能被 `claude plugin validate` 通过、能软链进 dev-mods 直接跑。不放任何开发期脚本 |
| `plugin/hooks/` | `register.tsx` 逻辑 + `art.ts` / `lines.ts` / `audio.ts` 数据与辅助 | 逻辑集中在一个 `register.tsx`，其余是纯数据或纯函数，不反向依赖 register |
| `plugin/data/` `plugin/assets/` | 二进制素材（帧数据、音频） | **只能由 `tools/` 生成，禁止手改** |
| `tools/` | 从原始素材生成 `plugin/` 内容的 Python 流水线 | 每个脚本独立可跑、输出确定；跑完打 SHA-256 打印出来 |
| `naiwa.md` `naiwa-images/` `naiwa-videos/` | Minus 提供的原始素材 | **只读，永不修改** |
| `docs/superpowers/specs/` | 设计文档 | 改设计先改这里，再改代码 |
| `_design-preview/` | 开发期预览产物 | 临时目录，交付后删（**删除前必须先问 Minus**） |

## 生成物 vs 手写物

`plugin/hooks/art.ts`、`plugin/data/laugh.bin`、`plugin/assets/laugh.mp3` 是**生成物**，
文件头会写明来源脚本。改它们 = 改 `tools/` 再重跑：

```bash
python3 tools/build_art.py      # naiwa-images/ + 视频帧  -> plugin/hooks/art.ts
python3 tools/build_laugh.py    # naiwa-videos/glimpse.mp4 -> plugin/data/laugh.bin + plugin/assets/laugh.mp3
```

其余文件手写。

## 硬约束（踩过的坑，别再踩）

- **`$.audio.play({asset})` 在 Linux 上不播任何东西。** 官方文档明说：`afplay` 只在 macOS 可用，Linux/Windows "having no player, plays nothing"。Linux 必须走 `$.process.run(['paplay', ...])`。
- **`$.audio.speak` 是 macOS 的 `say`。** Linux 退路是 `spd-say`。
- **被动开面板要 ≥144 列终端，被开过一次后降到 110 列。** 本机终端 80 列，所以**自动触发永远落不下面板**；`$.ui.blit` 在 Raster 未挂载时返回 `{ deny }`，自动触发也放不了动画。动画只走用户主动路径（`/naiwa-laugh` 属于 "asked"，80 列也能落）。
- **`$.ui.blit` 的定时器必须在所有退出路径上 `cancel()`**，否则面板关了动画还在跑。
- **热重载会重置模块变量。** 跨会话/跨重载要留的值走 `$.store`；会话内的走 `atom`/`read`/`update`。
- **`--plugin-dir` 和 dev-mods 都是 session-only 的，活不过重启。** 官方原文 "Load a plugin from a
  directory ... **for this session only**"。`~/.claude/dev-mods/<session-id>/` 是它按 session 落地
  的目录，往里软链只对那一个 session 有效，**不是安装**。持久加载走 `CLAUDE_CODE_PLUGIN_DIRS`
  环境变量（已写进 `~/.claude/settings.json` 的 `env`）。

## 测试环境（和真机不一样，写测试前先读这段）

`claude plugin test` 跑在一个「插件下面什么都没有」的引擎里，有两条反直觉的规则：

- **测试体里的 `$` 只有驱动用的名词**：`tool` `command` `prompt` `session` `turn` `ui` `classic` 等，
  **没有** `fs` / `process` / `clock` / `store` / `state`。所以不能在测试体里直接 `$.fs.exists(...)`，
  只能通过插件自身的行为间接触发（比如 `$.session.start()` 会走到 `detect()` → `fs.exists`）。
- **插件在 hook 里拿到的 `$` 是完整引擎**，它调的每个 `$.noun.verb` 都变成事件，测试用 `on(...)` 当实现。
  但 hook 签名永远是 `($, e, next)` —— **第一个参数是 `$` 不是 `e`**，写成 `e => ...` 会拿到引擎对象，
  然后在 `e.path.endsWith` 上炸掉。
- op 事件的 hook 返回 **`{ value: <结果> }`** 或 `{ deny }`；只有 `tool.call` 是 `{ result }` / `{ deny }`。
  返回 `{ command: ... }` 这类裸对象会被跳过，然后报 "no implementation for X"，看着像没实现，其实是返回形状错了。
- **同一个事件不能 `on` 两次**，会 "hooks module did not load"。用了 `mock.store(on)` 就不要再 `on('store.get')`。
- `test(name, options, body)` —— options 在**中间**，写在 body 后面文件整个加载不了。

## 素材事实（已核实，别再重新试）

- `naiwa-images/大笑.jpg` 和 `伤心失落.jpg` 是 **3/4 背身视角，没有脸**，四组更紧的裁剪框都救不回来 → **不做"伤心"表情**，"大笑"静态图从视频帧取。
- 视频第 396 帧之后是"笑到倒地"。横躺构图在 44×26 里必然糊，**动画砍在 356 帧**。
- 所有素材背景都是纯白 `255,255,255`。奶蛙肚子是 `248,240,216`（min 216）—— 判背景的规则不能误伤肚子。
- 画布固定 **44 列 × 26 行**（44×52 像素，半块字符 `▀`，`0x01000000` = 透明）。

## 验证（改完必须跑，不要只改不验）

```bash
claude plugin validate plugin/          # 清单 + 模块 + $.state 契约
claude plugin test plugin/              # register.test.ts

# 证明插件在真实引擎里加载并注册了 hooks（必须在项目目录外跑，排除 CWD 干扰）
cd /tmp && claude -p --debug-file /tmp/naiwa-load.log "ok" >/dev/null 2>&1
grep -c 'hooks module naiwa@inline loaded' /tmp/naiwa-load.log   # 期望 1
grep -o 'Found [0-9]* plugins' /tmp/naiwa-load.log               # 期望 9（8 个原有 + naiwa）
```

加载方式（`~/.claude/settings.json` 的 `CLAUDE_CODE_PLUGIN_DIRS`）见 README 的「装」一节。
真机手测清单在 `docs/superpowers/specs/` 的设计文档末尾。

## 红线

照 `~/.claude/CLAUDE.md`：删文件/目录/git 历史、改 `.env` 与密钥、改 CI/CD、`git push`/`rebase`/`reset --hard`、
装全局依赖、改系统配置、公开发布 —— **一律先问 Minus**。
