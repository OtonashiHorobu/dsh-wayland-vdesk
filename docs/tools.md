# 工具直调文档（agent 视角）

插件给**所有** agent 注册了 7 个工具。它们共享同一个前提：**每个对话只有一个桌面**，
由 DSH 的 session id 绑定 —— 你不需要传 session id，工具自己取。

一次典型调试长这样：

```text
1. vdesk_create({width: 1440, height: 900})
2. vdesk_run({command: "npm run dev", wait: false})        # 后台起服务/窗口
3. vdesk_run({command: "sleep 3", wait: true})             # 等它起来
4. vdesk_shot()                                            # 看渲染结果（图片进上下文）
5. vdesk_input({actions: [{type:"click", x:640, y:400}]})
6. vdesk_input({actions: [{type:"type", text:"hello"}]})
7. vdesk_shot()                                            # 验证交互结果
```

---

## `vdesk_create`

打开（或复用）本对话的桌面，返回 id、尺寸、X11 display 和可分享的 live view URL。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `width` | integer | 宽度，默认插件配置（1280） |
| `height` | integer | 高度，默认 800 |

返回：

```json
{ "id": "s-0k3u3l2", "width": 1280, "height": 800, "url": "http://127.0.0.1:7317/?token=…", "x11Display": ":1" }
```

**幂等**：重复调用返回同一个桌面；只在你传了不同宽高时顺便 resize。
其它工具在桌面不存在时会**自动创建**，所以只有想指定尺寸时才必须显式调用。

---

## `vdesk_run`

在桌面里启动程序。这是「注入任何程序」的入口。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `command` | string | 必填。不带 `args` 时交给 `/bin/sh -c`，所以管道、重定向、`&&` 都行 |
| `args` | string[] | 给了就按 argv 直接 exec，不过 shell |
| `cwd` | string | 工作目录，默认 home |
| `env` | object | 追加环境变量 |
| `wait` | boolean | 等程序退出并收集输出，默认 false |
| `timeoutMs` | integer | `wait:true` 时的超时，默认 30000，超时返回 `exitCode:124` |

返回（后台模式）：

```json
{ "pid": 497303, "command": "npm run dev", "log": "/run/user/1000/dsh-vdesk/sessions/s-…/log/app-01.log" }
```

返回（`wait:true`）：

```json
{ "pid": 497713, "command": "echo hi", "exitCode": 0, "stdout": "hi\n", "stderr": "" }
```

要点：

- **GUI 程序不要 `wait`**，它会一直占着调用直到超时。用后台模式，然后 `vdesk_shot` 看结果。
- 程序继承 `DISPLAY` / `WAYLAND_DISPLAY` / `XDG_RUNTIME_DIR` / `PULSE_SINK`，
  所以声音只会进桌面的 null sink，不会吵到用户。
- 输出有 64 KiB 上限（每次调用），超长请重定向到文件再读。

---

## `vdesk_shot`

截图并**作为图片返回**（走 DSH 的 attachment store，模型侧直接可见，不需要再 `read_image`）。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `region` | string | 裁剪区域 `"x,y WxH"`，桌面坐标 |
| `maxWidth` | integer | 等比缩放到这个宽度（省 token） |

```json
{ "width": 1280, "height": 800, "image": { "mediaType": "image/png", … } }
```

返回的文本里带了图片元信息；图片本体作为 image block 跟在后面。

---

## `vdesk_input`

指针与键盘输入。坐标是桌面像素，左上角为原点。

```json
{
  "actions": [
    { "type": "click", "x": 640, "y": 400 },
    { "type": "type", "text": "hello" },
    { "type": "key", "combo": "ctrl+s" }
  ]
}
```

| type | 必填 | 可选 |
| --- | --- | --- |
| `click` | `x`,`y` | `button`（left/middle/right）、`hold`、`delay` |
| `move` | `x`,`y` | — |
| `drag` | `from`,`to` | `steps`、`delay`、`button` |
| `scroll` | `x`,`y`,`direction` | `amount` |
| `type` | `text` | `method`（`auto`/`wtype`/`paste`）、`delay` |
| `key` | `combo` | — |

要点：

- **键盘输入发给焦点窗口**，所以先 `click` 把焦点给对。
- 非 ASCII（中文等）：`method:"paste"` 更稳（走 `wl-clipboard` + Ctrl+V）；
  `auto` 会在文本超过 40 字符时自动选 paste。
- `key` 用 XKB keysym：`Return`、`Tab`、`Escape`、`BackSpace`、`Prior`/`Next`（PageUp/PageDown）、
  `Up/Down/Left/Right`，组合用 `ctrl+shift+t`。
- 一次调用按顺序执行；任何一步失败会抛错，前面的步骤已经生效。

---

## `vdesk_windows`

列出桌面里的窗口，用来「先确认有没有真起来」再决定点哪里。

```json
{ "windows": [
  { "appId": "gtk4-demo", "title": "GTK 4 Demo", "x": 40, "y": 40, "width": 1200, "height": 800, "focused": true, "x11": false }
] }
```

`x11:true` 说明它是 Xwayland 客户端（对它的输入走合成器转发，行为一致）。

---

## `vdesk_apps`

列出这个桌面启动过的程序和它们的窗口，用来决定结束谁。

```json
{
  "apps": [
    { "pid": 497303, "command": "chromium --app=http://localhost:5173", "alive": true, "log": "…/app-01.log" }
  ],
  "windows": [
    { "id": 4194352, "pid": 497303, "appId": "chromium", "title": "My App", "width": 1200, "height": 740, "focused": true }
  ]
}
```

---

## `vdesk_kill`

结束一个程序（连同进程组）或只关掉一个窗口。`pid` 和 `windowId` 二选一。

```json
{ "pid": 497303 }        // 程序退出
{ "windowId": 4194352 }  // 只关窗口，程序继续跑
```

---

## `vdesk_resize`

```json
{ "width": 1920, "height": 1080 }
```

范围 `320..7680 × 240..4320`。窗口会按合成器规则重排；网页里的画面会自动跟着变。

---

## `vdesk_stop`

停止本对话的桌面与里面所有程序。下次任意 `vdesk_*` 调用会重建一个干净的。
不调用也没关系：4 小时无人使用会被回收。

---

## 给模型的使用建议

1. **先 `vdesk_windows` 再 `click`**：窗口还没起来时点是空点。
2. **启动后等一小会儿**：GUI 程序从 fork 到首帧有 200ms~2s 的延迟，用
   `vdesk_run({command:"sleep 2", wait:true})` 等，别连续截图浪费 token。
3. **截图用 `maxWidth: 1280`**：debug 布局够用，能显著省 context。
4. **失败时先看日志**：`vdesk_run` 返回的 `log` 路径就是程序 stdout/stderr；
   自己 `read` 一下比反复截图快。
5. **一次只动一件事**：`click` → `shot` → `type` → `shot`，比一次性发一串动作更容易定位问题。
6. **桌面是共享的**：用户可能同时在网页里操作同一个桌面。动手前先 `vdesk_shot` 看一眼现状。
