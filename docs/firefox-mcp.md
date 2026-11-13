# Firefox MCP：让 agent 用结构化工具调试网页

`dsh-vdesk` 提供一个 `vdesk_browser` 工具，把 Firefox 起在对话的虚拟桌面里，并打开 Marionette；
`examples/firefox-preset` 则把 Mozilla 官方的
[firefox-devtools-mcp](https://github.com/mozilla/firefox-devtools-mcp) 挂进 **standard agent preset**，
以「attach 到已有浏览器」的方式连接。

两个能力合起来就是：**网页跑在离屏桌面里，agent 既能看到像素，也能用 console / network / 断言级 API 操作。**

## 组成

```
DSH session (standard preset)
 ├── mcp-firefox (stdio MCP server, attach mode)
 │      └── --connect-existing --marionette-port 2828
 │            │ Marionette / WebDriver BiDi
 ▼            ▼
vdesk 虚拟桌面里的 Firefox  ← vdesk_browser 启动（-P vdesk-ff --no-remote）
```

## 启用

### 1. 安装 MCP 服务器（无需全局安装）

```bash
npx -y @mozilla/firefox-devtools-mcp@0.10.7 --help
```

### 2. 把 MCP 挂进 standard preset

```bash
dsh plugin --profile web add examples/firefox-preset
```

`examples/firefox-preset/cordis.patch.yml` 覆盖了内置的 `preset-standard`：
因为覆盖会**整段替换** `config`，文件里原样重述了官方插件清单，并在末尾加了一条 `mcp-firefox`。
升级 DSH 后如果官方 preset 变了，需要同步这份清单。

### 3. 启动浏览器

在对话里让 agent 调用：

```text
vdesk_browser({url: "http://localhost:5173"})
```

或者手动：

```bash
eval "$(dsh-vdesk env <conv>)"
firefox -P vdesk-ff --no-remote --marionette --remote-debugging-port=9222
```

`vdesk_browser` 会：

1. 需要时用 `firefox -CreateProfile "vdesk-ff ~/.mozilla/firefox/vdesk-ff"` 建独立 profile；
2. 以 `-P vdesk-ff --no-remote --marionette --remote-debugging-port=9222` 在桌面里启动；
3. 轮询 `127.0.0.1:2828`，确认 Marionette 已就绪再返回。

## 可用的工具

`--tool-preset developer` 打开 49 个工具，其中和 UI 调试最相关的是：

| 工具 | 用途 |
| --- | --- |
| `list_console_messages` / `get_console_message` | 控制台日志与报错 |
| `list_network_requests` / `get_network_request` | 请求、响应体、失败原因 |
| `screenshot_page` | 页面截图（和 `vdesk_shot` 互补：一个只要页面，一个要整个桌面） |
| `evaluate_script` | 在页面里执行 JS 并取回结果 |
| `take_snapshot` / `click_by_uid` / `fill_by_uid` | 无障碍树快照 + 稳定 UID 驱动点击输入 |
| `navigate_page` / `new_page` / `close_page` | 页面管理 |

## 注意

- **一个 Firefox 只能有一个自动化会话**。MCP 通过 `--idle-timeout 1800` 在空闲 30 分钟后自动释放；
  另一个对话再调用 `vdesk_browser` 会被拒绝，需要先等它释放或手动关掉那个浏览器。
- **必须用独立 profile + `--no-remote`**：否则再启动一次只会给已有 Firefox 开窗口，
  `--marionette` 会被静默忽略。
- **`--remote-debugging-port` 是 WebDriver BiDi，不是 CDP**，所以 Playwright MCP、Puppeteer 的
  `--cdp-endpoint` 都连不上 Firefox。
- **Marionette 会设置 `navigator.webdriver = true`**，部分站点（Cloudflare 等）会拦；调试真实站点时留意。
- 首次 attach 需要联网让 geckodriver 落到 `~/.cache/selenium`。
