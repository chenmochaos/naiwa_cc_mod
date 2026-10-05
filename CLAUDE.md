# naiwa_cc_mod

奶蛙（Naiwa）陪你写代码 —— 一个 Claude Code mod。功能对齐 [`CocoSgt/yujie-mod`](https://github.com/CocoSgt/yujie-mod)，形象与说话方式换成原创角色奶蛙。

## 这是什么

Claude Code ≥ 2.1.287 的原生插件（不是第三方框架）。它在终端里给模型加一层人设：
台词条、表情面板、危险命令拦截、说话风格注入 system prompt、以及一个"下班大笑"彩蛋。

## 目录约定

| 目录 | 放什么 | 规则 |
| --- | --- | --- |
| `plugin/` | **插件本体，唯一的交付物** | 这里的内容必须自洽：能被 `claude plugin validate` 通过、能软链进 dev-mods 直接跑。不放任何开发期脚本 |
| `plugin/hooks/` | `register.tsx` 编排 + `signals.ts`（场合判定/安全正则/冷却）、`faces.ts`（面板分档）、`gen.ts`（LLM 请求与净化）、`lines.ts`（模板与理由）、`audio.ts`、`*-meta.ts`（生成物） | 逻辑集中在一个 `register.tsx`，其余是纯数据或纯函数，不反向依赖 register；**碰 `$` 的代码只能写在 register.tsx** |
| `plugin/data/` `plugin/assets/` | 二进制素材（帧数据、音频） | **只能由 `tools/` 生成，禁止手改** |
| `tools/` | 从原始素材生成 `plugin/` 内容的 Python 流水线 | 每个脚本独立可跑、输出确定；跑完打 SHA-256 打印出来 |
| `naiwa.md` `naiwa-images/` `naiwa-videos/` | Minus 提供的原始素材 | **只读，永不修改** |
| `docs/superpowers/specs/` | 设计文档 | 改设计先改这里，再改代码 |
| `_design-preview/` | 开发期预览产物 | 临时目录，交付后删（**删除前必须先问 Minus**） |

## 生成物 vs 手写物

`plugin/data/faces.bin`、`plugin/hooks/face-meta.ts`、`plugin/data/laugh.bin`、
`plugin/hooks/laugh-meta.ts`、`plugin/assets/laugh.mp3` 是**生成物**，文件头会写明来源脚本。
改它们 = 改 `tools/` 再重跑：

```bash
python3 tools/build_art.py                 # 四表情 × 三档 -> plugin/data/faces.bin + plugin/hooks/face-meta.ts
python3 tools/build_art.py --preview       # 顺手把 12 张图拼成 _design-preview/30-art核对.png
python3 tools/build_laugh.py               # naiwa-videos/glimpse.mp4 -> plugin/data/laugh.bin + plugin/assets/laugh.mp3
```

其余文件手写。**淘汰记录**：v0.2 的 `plugin/hooks/art.ts`（44×26 单尺寸 TS 字面量网格）
已被 `faces.bin` 取代并删除 —— 单一尺寸在某些终端上必然被裁，这是 v0.3.0 修的 bug。

## 硬约束（踩过的坑，别再踩）

- **`$.audio.play({asset})` 在 Linux 上不播任何东西。** 官方文档明说：`afplay` 只在 macOS 可用，Linux/Windows "having no player, plays nothing"。Linux 必须走 `$.process.run(['paplay', ...])`。
- **`$.audio.speak` 是 macOS 的 `say`。** Linux 退路是 `spd-say`。
- **开面板分「asked」和「unasked」，宽度门槛天差地别。**
  asked（你敲的命令 / 你发的消息 / 你按的按钮）**任何宽度都落**；unasked（`session.start`、定时器、队列里的 prompt）
  要 ≥144 列，这个 id 以前被人开过才降到 110。本机 80 列 —— 所以**只有 asked 时机拿得到面板**。
  v0.3.0 的解法是把开面板挪到 `prompt.submit`（见 `ensurePane`），不是去调宽度。
- **面板高度是引擎给的，不是你要的。** 实测：80×24 → 6 行，80×40 → 11 行，80×60 → 18 行，
  140×24 → 16 行，140×40 → 32 行。`$.ui.open({ rows: N })` **实测无效**（传 30 和不传一样）。
  任何往面板里画固定高度东西的代码，都必须先问 `e.props.scroll.bodyRows` —— v0.2「打开了却看不到奶蛙」
  就是因为 26 行的脸被塞进 6 行的面板。
- **`$.ui.blit` 在 Raster 未挂载时返回 `{ deny }`**（面板被关掉了），不是错误。动画只走用户主动路径
  （`/naiwa-laugh` 属于 asked，80 列也能落）。
- **`$.ui.blit` 的定时器必须在所有退出路径上 `cancel()`**，否则面板关了动画还在跑。
- **热重载会重置模块变量。** 跨会话/跨重载要留的值走 `$.store`；会话内的走 `atom`/`read`/`update`。
- **`--plugin-dir` 和 dev-mods 都是 session-only 的，活不过重启。** 官方原文 "Load a plugin from a
  directory ... **for this session only**"。`~/.claude/dev-mods/<session-id>/` 是它按 session 落地
  的目录，往里软链只对那一个 session 有效，**不是安装**。持久加载走 `CLAUDE_CODE_PLUGIN_DIRS`
  环境变量（已写进 `~/.claude/settings.json` 的 `env`）。

## 测试环境（和真机不一样，写测试前先读这段）

`claude plugin test` 跑在一个「插件下面什么都没有」的引擎里，有几条反直觉的规则：

- **测试体里的 `$` 只有驱动用的名词**：`tool` `command` `prompt` `session` `turn` `ui` `classic` 等，
  **没有** `fs` / `process` / `clock` / `store` / `state`。所以不能在测试体里直接 `$.fs.exists(...)`，
  只能通过插件自身的行为间接触发（比如 `$.session.start()` 会走到 `detect()` → `fs.exists`）。
- **插件在 hook 里拿到的 `$` 是完整引擎**，它调的每个 `$.noun.verb` 都变成事件，测试用 `on(...)` 当实现。
  但 hook 签名永远是 `($, e, next)` —— **第一个参数是 `$` 不是 `e`**，写成 `e => ...` 会拿到引擎对象，
  然后在 `e.path.endsWith` 上炸掉。
- **返回形状分两类，别混**：`$.noun.verb` 这类 **op 事件**返回 `{ value: <结果> }` 或 `{ deny }`；
  **引擎事件**（`prompt.submit` / `ui.render` / `prompt.compose` / `session.start` / `command.run` …）
  返回**裸结果**。op 事件返回裸对象、或引擎事件多包一层 `{ value }`，都会被跳过，
  然后报 "no implementation for X"，看着像没实现，其实是返回形状错了。
- `tool.call` 的 hook 返回 `{ result }` / `{ deny }`，**但 `text` 和 `isError` 只有核心会盖**。
  测试里的桩如果只回 `{ result: { stdout } }`，插件就读不到「命令挂了」—— 要让插件看见失败，
  桩得按核心的形状给齐 `{ result, text, isError: true }`。
- **同一个事件不能 `on` 两次**，会 "hooks module did not load"。用了 `mock.store(on)` 就不要再 `on('store.get')`。
- **所有 `on(...)` 必须在第一次碰 `$` 之前注册完**，否则 "on(...) after the test first called $"。
- 插件在 hook 里 `return next(e)` 时，链子**底下必须有人接**（`on('prompt.submit', ...)` 之类），
  否则 "nothing beneath the plugins answers X"。
- **模块变量和 atom 活得过同一文件里的下一条 test**。所以每个测试自己的时钟起点不一样时，
  上一条留下的 `speech.at` 会比这条的 `now` 还大，冷却判定永远不过 —— 症状是「这条测什么都没发生」。
- `test(name, options, body)` —— options 在**中间**，写在 body 后面文件整个加载不了。

## 素材事实（已核实，别再重新试）

- **`伤心失落.jpg` 有脸**（3/4 侧身低头，一只垂眼 + 下撇的嘴，肩膀垮着），裁剪框 `(0.00, 0.00, 0.42, 0.44)`。
  v0.2 时这里曾记「背身没脸、不做伤心表情」—— **那条是错的**，当时裁错了框就下了结论。已作废。
- `naiwa-images/大笑.jpg` 同样没被采用，「大笑」静态图取自视频第 270 帧。
- 视频第 396 帧之后是"笑到倒地"。横躺构图在 44×26 里必然糊，**动画砍在 356 帧**。
- 所有素材背景都是纯白 `255,255,255`。奶蛙肚子是 `248,240,216`（min 216）—— 判背景的规则不能误伤肚子。
- 裁剪框是**人工标注**的，不要改成自动暗部检测（会抓到深色手部/阴影而不是脸，试过两轮都失败）。
  改框之后必须 `--preview` 肉眼确认。
- 画布三档：**44×26（full）/ 26×15（mid）/ 22×6（mini）**，都由同一个裁剪框渲染。
  半块字符 `▀`/`▄`，`0x01000000` = 透明。选档规则见 `plugin/hooks/faces.ts`。

## 验证（改完必须跑，不要只改不验）

```bash
claude plugin validate plugin/          # 清单 + 模块 + $.state 契约
claude plugin test plugin/              # register.test.ts，34 条，必须全绿

# 证明插件在真实引擎里加载并注册了 hooks（必须在项目目录外跑，排除 CWD 干扰）
cd /tmp && claude -p --debug-file /tmp/naiwa-load.log "ok" >/dev/null 2>&1
grep -c 'hooks module naiwa@inline loaded' /tmp/naiwa-load.log   # 期望 1（日志是追加的，数这次那行）
grep -o 'Found [0-9]* plugins' /tmp/naiwa-load.log               # 期望 9（8 个原有 + naiwa）
```

**真机面板复现**（改面板/表情必跑，脚本在 `/tmp/naiwa_pty.py` + `/tmp/screen.py`）：
起一个真 pty 会话，发一条消息，把字节流还原成屏幕，肉眼确认面板里有脸 + 台词 + 心情。
`/tmp/screen.py <raw> <cols> <rows>` 是那个 ANSI 还原器（纯文本 grep 看不到像素画，
因为半个方块字符会被 ANSI 清理掉 —— 别用它下「面板没画」的结论）。
判定「引擎到底放没放进面板」看 debug 日志，别猜：

```bash
grep -oE "ui\.open naiwa naiwa \([a-z]+, [0-9]+ columns\): [a-z ]+" /tmp/pane-*.log
# 80 列上期望同时出现： (unasked, 80 columns): waits unplaced   ← session.start 那次，正常
#                        (asked, 80 columns): placed            ← prompt.submit 那次，这就是修复点
```

加载方式（`~/.claude/settings.json` 的 `CLAUDE_CODE_PLUGIN_DIRS`）见 README 的「装」一节。
真机手测清单在 `docs/superpowers/specs/` 的设计文档末尾。

## 红线

照 `~/.claude/CLAUDE.md`：删文件/目录/git 历史、改 `.env` 与密钥、改 CI/CD、`git push`/`rebase`/`reset --hard`、
装全局依赖、改系统配置、公开发布 —— **一律先问 Minus**。
