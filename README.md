# dsh-vdesk

给 **DeepSeek Harness** 的每个对话一个**离屏虚拟桌面**：GUI 程序跑在独立的 headless Wayland（sway + Xwayland）里，
不会出现在你真实的 Hyprland 桌面上；agent 可以启动程序、截图、点击、输入，你在 DSH 网页里能实时看到并直接操作，
声音经 WebUI 转发且默认静音。

```
┌────────────────────────────── DSH Web (127.0.0.1:3080) ──────────────────────────────┐
│  对话视图「虚拟桌面」  ──iframe──▶  hub 页面 (127.0.0.1:7317)                          │
│                                        │  noVNC 画面 + WebAudio 声音                    │
└────────────────────────────────────────┼──────────────────────────────────────────────┘
                                         │ RFB / PCM
                              ┌──────────▼──────────┐
                              │  dsh-vdesk daemon   │  每个对话一个会话
                              │  sway (headless)    │  ┌────────────────────────────┐
                              │  wayvnc (127.0.0.1) │──│ 你的程序 (Wayland / X11)    │
                              │  null sink + parec  │  └────────────────────────────┘
                              └─────────────────────┘
```

## 它解决什么

- **隔离**：程序渲染在你自己的 sway 实例里，`hyprctl clients` 永远看不到它们；不会抢焦点、不会遮挡你的窗口。
- **可指定大小**：`1280x800`、`1920x1080`、竖屏 `1080x1920` 都行，运行中还能 `vdesk_resize`。
- **双向可见**：agent 用 `vdesk_shot` 拿 PNG 图片；你用人眼看 live view，还能用鼠标键盘直接操作。
- **任意程序**：`vdesk_run` 注入 `DISPLAY` / `WAYLAND_DISPLAY` / `XDG_RUNTIME_DIR` / `PULSE_SINK`，
  GTK、Qt、Electron、Chromium、Wine、游戏引擎都一样。
- **声音**：每个桌面一个独立 null sink，默认静音；WebUI 里点一下才出声，音量滑杆可调。
- **每对话独立**：会话按 DSH 的 conversation id 绑定，两个对话互不干扰。

## 安装

### 1. 系统依赖（Arch）

```bash
sudo pacman -S sway wayvnc grim wtype wl-clipboard
```

| 程序 | 用途 |
| --- | --- |
| `sway` | headless 合成器（Wayland + Xwayland） |
| `wayvnc` | 把桌面画面/输入经 RFB 暴露到 127.0.0.1 |
| `grim` | 截图 |
| `wtype` | 键盘注入（合成器级虚拟键盘，不碰 `/dev/uinput`） |
| `wl-clipboard` | 长文本/中文的粘贴式输入（可选） |

noVNC 只用于浏览器端，Arch 包 `novnc` 会装到 `/usr/share/webapps/novnc`；
也可以用 `DSH_VDESK_NOVNC` 指向别的目录。

### 2. 安装插件

```bash
# 从本地目录
dsh plugin --profile web add /path/to/dsh-vdesk
# 或者从 GitHub（发布后）
dsh plugin --profile web add gh:OtonashiHorobu/dsh-vdesk
```

插件由两部分组成：

- **Host 半** `index.js`：注册 7 个 agent 工具 + 1 条鉴权路由；
- **Client 半** `client.js`：在对话视图里加一个「虚拟桌面」页签。

两者都不需要构建步骤。装好后刷新网页即可看到页签。

### 3. 唯一后台进程

所有桌面由一个常驻守护进程提供（工具、CLI、网页共用同一份状态）：

```bash
dsh-vdesk start      # 后台拉起 hub
dsh-vdesk status     # 看 caps / 端口 / 桌面列表
```

端口默认 `7317`（`DSH_VDESK_PORT` 可改），运行时文件在 `$XDG_RUNTIME_DIR/dsh-vdesk/`。

## 快速使用

### agent 侧（工具直调）

```text
vdesk_create()                                  → 打开本对话的桌面
vdesk_run({command: "gtk4-demo"})               → 里面跑一个 GUI 程序
vdesk_shot()                                    → 截图，图片直接进上下文
vdesk_input({actions:[{type:"click",x:120,y:80}]}) → 点一下
vdesk_input({actions:[{type:"type",text:"你好"}]})  → 打字
vdesk_apps()                                    → 桌面里有哪些程序/窗口
vdesk_kill({pid: 1234})                         → 结束某个程序
```

完整工具参数见 [docs/tools.md](docs/tools.md)。

### 左侧「虚拟桌面」总览

侧边栏点 **虚拟桌面** 打开全屏总览：每个对话一张卡片，带实时缩略图、尺寸、程序数，
可以直接打开、在窗口打开或停止。同一页还有「全部停止」。

### 停止桌面 / 管理里面的程序

桌面页右上角：

- **程序** —— 列出这个桌面启动过的程序和它们的窗口，点 ✕ 结束某个程序或关掉某个窗口；
- **停止** —— 结束整个桌面（里面的程序全部退出）。

agent 侧对应 `vdesk_apps` 与 `vdesk_kill`。

### 你（WebUI）

对话顶部页签切到 **虚拟桌面**：

- 画面上直接鼠标/键盘操作，等同坐在那台机器前；
- 右上角 🔇 **声音**：默认静音，点一下开启，旁边滑杆调音量；
- **在窗口打开**：把同一个桌面丢到独立浏览器窗口，适合双屏；
- **重载**：重连画面。

### shell 侧（CLI）

```bash
dsh-vdesk create --conv my-app --size 1440x900
dsh-vdesk run my-app -- ./target/debug/my-app --flag
dsh-vdesk shot my-app --out /tmp/shot.png
dsh-vdesk env my-app           # 打印 export 行，可 eval 注入 shell
dsh-vdesk click my-app 640 400
dsh-vdesk type my-app "hello"
```

完整命令见 [docs/cli.md](docs/cli.md)。

## 设计要点

- **每对话一个 sway**：私有 `XDG_RUNTIME_DIR`，私有 `WAYLAND_DISPLAY`（`wayland-1`），Xwayland 自动分配 `:N`。
- **输入不走 uinput**：键盘用合成器级虚拟键盘（`wtype`），指针用 sway 自己的
  `seat - cursor set/press/release`，WebUI 的输入走 wayvnc 的虚拟设备。
  因此**永远不会误触你真实桌面**（`ydotool`/`dotool` 那种全局注入在这里是禁止项）。
- **音频**：`pactl load-module module-null-sink` 给每个桌面一个 sink，
  程序的 `PULSE_SINK` 指向它；浏览器连上来时才开始 `parec` 采 monitor，
  断线 8 秒后自动停，避免常驻空转。
- **单端口**：hub 一个端口同时提供页面、静态 noVNC、`/vnc/<id>` 代理、`/audio/<id>` 音频流，
  不需要 websockify，也不需要额外端口。
- **鉴权**：hub 只监听 `127.0.0.1`，所有 URL 带一次性 token；API 与 WebSocket 都校验。

更多细节见 [docs/architecture.md](docs/architecture.md)。

## 限制与注意

- **仅 Linux**（Wayland 合成器 + PipeWire/PulseAudio）。Windows/macOS 不支持。
- 显示隔离**不是安全沙箱**：同一 uid，程序仍能读你的文件。跑不可信程序请用容器/虚拟机。
- 输入法（IME）不可用：中文请用 `method:"paste"`（走 `wl-clipboard`），或直接 `type` 拉丁字符。
- 如果 DSH 用 HTTPS 提供服务，浏览器会拦截 `http://` 的 iframe（mixed content）。本地 `http://127.0.0.1:3080` 正常。
- 无 GPU 时会退到软件渲染；NVIDIA/AMD/Intel 上实测走 EGL（`/dev/dri/renderD*`）。

## 卸载

```bash
dsh-vdesk stop-hub
dsh plugin --profile web remove dsh-vdesk
```

## License

MIT
