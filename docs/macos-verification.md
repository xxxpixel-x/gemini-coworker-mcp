# macOS 后台调用验证

在给 macOS 写正式后端之前，先用一个小探针在真机上回答五个问题。任何一项不通过，macOS 后端都保持“不可发送”。

| # | 问题 | 由哪条命令回答 |
|---|---|---|
| 1 | 辅助功能 API 能否读到 Gemini 窗口里的界面元素，并从地址（AXURL）唯一标识一个对话？ | `inventory`、`probe` |
| 2 | 能否在 Gemini 不在前台时写入输入框？ | `probe` 看是否可写，`roundtrip` 实测 |
| 3 | 写入后能否找到唯一的发送按钮并按下？ | `roundtrip` |
| 4 | 能否读到本轮完整回复，包括中文、换行和缩进？ | `roundtrip` |
| 5 | 整个往返过程中前台应用、输入焦点和剪贴板是否保持不变？ | `roundtrip`，分场景各跑一次 |

探针源码在 [native/macos/GeminiAXProbe.swift](../native/macos/GeminiAXProbe.swift)。除 `roundtrip` 外的命令只读，不会修改对话内容。启动时探针会给 Gemini 进程设置 `AXManualAccessibility`，请求 Chromium/Electron 生成辅助功能树；加 `--enhanced` 时还会设置 `AXEnhancedUserInterface`。

## 准备

- Apple Silicon、macOS 15 或更高版本，已安装并登录 Gemini for Mac。
- Xcode 或 Command Line Tools（`xcode-select --install`）。
- 在仓库根目录编译：

```bash
swiftc -O -o gemini-ax-probe native/macos/GeminiAXProbe.swift
mkdir -p probe-results
```

- 第一次运行时 macOS 会请求辅助功能权限。授权对象是运行探针的终端（“终端”或 iTerm），在“系统设置 › 隐私与安全性 › 辅助功能”中打开它，然后**重新打开终端**再运行。

## 第一步：盘点

```bash
./gemini-ax-probe inventory > probe-results/1-inventory.json
```

需要关注这些字段：

- `installs[].engine`：`electron` / `chromium` / `native-or-webkit` / `chrome-web-app-shim`。最后一种是 Chrome 安装的网页应用，不是 Gemini for Mac。
- `running`：同时运行多个候选时，后续命令要加 `--pid`。
- `windows[].web_areas[].kind`：`chat` 表示能从地址识别具体对话，并给出路由哈希；`blank` 表示新对话页；`none` 表示读不到地址，问题 1 不通过。

如果 `web_areas` 为空，加 `--enhanced` 再试一次；仍为空时运行 `dump` 并把结果发回来。

## 第二步：只读探测

先在 Gemini 中新建一个专用对话，随便发一句话，让地址变成具体对话（`kind` 为 `chat`）。保持输入框为空。

```bash
./gemini-ax-probe probe --window 0 > probe-results/2-probe.json
```

- `editables` 中应只有一个输入框，并且 `value_settable` 或 `selected_text_settable` 为 `true`。
- `nearby_buttons` 列出输入框附近按钮的名称。输入框为空时发送按钮可能还不存在，这时 `send_buttons_near` 为 0 是正常的。
- `text_method` 为 `text-marker` 最理想；为 `static-text-join` 时也能读，但换行可能和显示的不一致；为 `none` 时问题 4 不通过。

## 第三步（可选）：完整树

只有 `probe` 没找到输入框或网页区域时才需要：

```bash
./gemini-ax-probe dump --window 0 > probe-results/3-dump.json
```

## 第四步：往返实测

每次运行都会向 `--window` 指定的对话**发送一条测试消息**。只用专用对话。

1. 打开“文本编辑”，新建一个空白文档。
2. 在终端运行下面的命令，在倒计时（默认 8 秒）内切换到“文本编辑”，并一直打字到命令结束（最长约 2 分钟）。
3. 结束后检查“文本编辑”里的文字是否完整、连续，有没有字符跑进 Gemini。

```bash
./gemini-ax-probe roundtrip --window 0 --scenario behind-other-app > probe-results/4a.json
```

按下表依次跑各个场景，每次只改变 Gemini 窗口的状态和 `--scenario` 名称：

| 场景名 | Gemini 窗口状态 | 目的 |
|---|---|---|
| `behind-other-app` | 部分可见，压在“文本编辑”下面 | 基本后台能力 |
| `fully-covered` | 被其他窗口完全遮住 | Chromium 遮挡后会节流渲染，可能读不到流式回复 |
| `minimized` | 最小化到程序坞 | 同上，且窗口可能不更新辅助功能树 |
| `hidden` | 在 Gemini 中按 ⌘H 隐藏 | 同上 |
| `other-space` | 移到另一个桌面空间（Space） | 切换空间是否会被触发 |
| `personal-gemini` | 你在 Gemini 的另一个窗口或对话里打字 | 仅当 Gemini 支持多窗口时适用 |

`personal-gemini` 场景下前台本来就是 Gemini，探针会拒绝发送。要测这个场景，需要先确认 Gemini 能开多个窗口，再告诉我，我给探针加上对应的检查模式。

如果 `roundtrip` 报告找不到可写的输入框，或 `draft_matches` 为 `false`，再用另一种写入方式试一次：

```bash
./gemini-ax-probe roundtrip --window 0 --input selected-text --scenario behind-other-app > probe-results/4a-selected.json
```

### 怎么看结果

- `passed: true`：本场景通过——成功发送，回复与预期逐字一致，没有发生任何焦点、剪贴板或对话变化。
- `not_sent: true`：探针确认没有按下发送按钮，并已尝试清空它写入的草稿。
- `sent: "unknown"` 或 `not_sent: false`：可能已经发出，请到对话里确认。
- `violations`：每类变化第一次出现的时间（秒）。`focused_element_tracked: false` 表示无法读取焦点元素，这一项没有检查。
- `unparsed_body`：找到了回执标记，但里面的内容不是预期的 JSON，用于排查渲染问题。

## 隐私

默认输出会把对话文本和输入框内容替换为字符数，但窗口标题、按钮名称和对话地址的哈希仍会出现。发回结果前请看一遍；`--show-text` 的输出不要分享。

## 发回什么

`probe-results/` 目录里的全部文件（它已被 Git 忽略），再附上你观察到的情况：“文本编辑”的输入是否被打断、Gemini 窗口有没有跳到前台、系统有没有切换桌面空间。

根据这些结果决定下一步：全部通过，就把探针改成和 [gemini-uia.ps1](../native/gemini-uia.ps1) 相同协议的正式辅助程序，接入 `DesktopAdapter`；部分场景失败，就只支持通过的场景，并在状态中说明原因；问题 1 或问题 2 不通过，macOS 改走网页版或远程 Windows 网关的路线。
