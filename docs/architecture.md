# 架构

## 进程模型

```
dsh (Host, 一个进程)
 └── dsh-vdesk plugin (index.js)          ← 注册工具 + /api/vdesk/*
        │ HTTP (127.0.0.1:7317)
        ▼
   dsh-vdesk daemon (独立 Node 进程)      ← 常驻，跨 DSH 重启存活
        ├── Hub: HTTP + WebSocket
        │     ├── /                viewer 页面
        │     ├── /vendor/novnc/*  静态 noVNC
        │     ├── /api/*           JSON API（token 鉴权）
        │     ├── /vnc/<id>        RFB over WebSocket 代理
        │     └── /audio/<id>      PCM(s16le/48k/2ch) over WebSocket
        ├── Session s-xxxx
        │     ├── sway (headless, 私有 XDG_RUNTIME_DIR)
        │     │     ├── wayland-1
        │     │     └── Xwayland :N
        │     ├── wayvnc  →  127.0.0.1:<随机端口>
        │     ├── null sink dsh_vdesk_<id> + parec（按需）
        │     └── 你启动的程序
        └── Session s-yyyy …
```

为什么用独立守护进程而不是把逻辑塞进 Host 插件：

- **CLI 与工具共享状态**：终端里 `dsh-vdesk run` 起的窗口，agent 一截图就能看见。
- **DSH 重启不炸**：插件被 HMR 重载/禁用时，已经跑着的桌面不会变成孤儿进程。
- **崩溃隔离**：sway/wayvnc 挂掉不会拖垮 DSH 进程。

守护进程本身很轻（空转时只有 http server + 定时器）。

## 一次 `vdesk_create` 发生了什么

1. `manager.ensure(key)`：按 conversation key 派生稳定 id `s-<hash7>`，已存在就直接复用。
2. 建目录 `$XDG_RUNTIME_DIR/dsh-vdesk/sessions/<id>/{run,log,shots}`，`run` 是权限 `0700` 的私有 `XDG_RUNTIME_DIR`。
3. 写 sway 配置：

   ```
   output HEADLESS-1 resolution 1280x800
   xwayland enable
   exec_always --no-startup-id sh -c 'env > ".../env"'
   ```

   这行 `exec_always` 是关键：sway 会给子进程注入它自己分配的 `DISPLAY`/`SWAYSOCK`，
   我们把它落盘成 `env` 文件，就能知道该给程序注入哪个 X display（多实例时是 `:1`、`:2`…）。
4. 以 `WLR_BACKENDS=headless` 起 sway，等 `run/wayland-*` 套接字出现。
5. 起 wayvnc：`wayvnc -o HEADLESS-1 -f 24 -r 127.0.0.1 <port>`，等端口可连。
6. `pactl load-module module-null-sink sink_name=dsh_vdesk_<id>`，等 sink 出现。
7. 状态置 `ready`。

## 画面链路

```
sway 合成器  ──wlr-screencopy──▶ wayvnc ──RFB over TCP──▶ hub /vnc/<id> ──WebSocket──▶ 浏览器 noVNC(RFB 类)
```

- 不做整套转码：RFB 的 `Tight`/`ZRLE` 对 UI 内容足够，CPU 占用低。
- `-f 24` 限帧，`-r` 让光标进入画面（截图/录屏时更直观）。
- 浏览器端用 noVNC 的 `RFB` 类（不是 `vnc.html`），所以我们能自己控制工具栏和布局。

## 音频链路

```
程序 → PULSE_SINK=dsh_vdesk_<id>  →  null sink  →  parec(.monitor)  →  PCM 帧  →  WebSocket  →  WebAudio(GainNode) → 扬声器
```

- **默认静音**：页面一开始根本不创建 `AudioContext`（也满足浏览器自动播放策略），
  只有用户点「声音」时才建图、连 WS、开始放。
- **按需采集**：第一个音频客户端连上才 `parec`，最后一个断开 8 秒后停，避免空转。
- **音量**：`GainNode` 在浏览器侧，不改 sink 音量，所以多端观看互不影响。
- 丢帧策略：`ws.bufferedAmount > 512 KiB` 时丢当前帧，宁可断音也不堆延迟。

## 输入链路

| 来源 | 路径 | 是否影响真实桌面 |
| --- | --- | --- |
| 网页鼠标/键盘 | noVNC → RFB → wayvnc 虚拟设备 → 该 sway | 否 |
| agent `click`/`move`/`scroll` | sway IPC `seat - cursor set/press/release` | 否 |
| agent `type`/`key` | `wtype` 虚拟键盘（`zwp_virtual_keyboard_v1`） | 否 |
| agent 长文本/中文 | `wl-copy` + `Ctrl+V` | 否 |

**刻意不用** `ydotool` / `dotool`：它们走 `/dev/uinput`，事件会进系统里**当前焦点**的会话，
也就是会打到用户真实的 Hyprland 上。这是这套设计里最重要的一条红线。

指针用 sway 自己的 seat 命令而不是 `zwlr_virtual_pointer`，是因为前者是绝对坐标、
映射到桌面像素最直接，也不依赖额外二进制。

## 鉴权与暴露面

- 只绑定 `127.0.0.1`。
- 每次 daemon 启动生成 128-bit token，写在 `$XDG_RUNTIME_DIR/dsh-vdesk/token`（`0600`），
  同时写进 `hub.json` 供 CLI/插件读取。
- HTTP API 与 WebSocket 都必须带 `?token=`（或 `x-vdesk-token` 头）。
  跨站页面无法读取 iframe 的 URL，因此拿不到 token —— 这挡住了「任意网页偷偷连你的 VNC」。
- `dsh-vdesk` 的 Hub 与 DSH 本身是**不同 origin**（3080 vs 7317），
  但 DSH 页面没有 CSP/`X-Frame-Options` 限制，所以 iframe 可以正常工作。

## 资源回收

- `vdesk_stop` / 插件禁用 / `stop-hub`：终止 wayvnc、sway 进程组，卸载 null sink，删会话目录。
- 空闲回收：60 秒扫一次，`ready` 且无 viewer 且 4 小时没活动 → 回收。
- 进程组：sway/wayvnc/程序都用 `detached:true` 起，用 `kill(-pid)` 杀整组，
  避免留下 Xwayland 或子进程。

## 为什么不选 Selkies / KasmVNC / Xpra

| 方案 | 结论 |
| --- | --- |
| **Selkies** | 画质/延迟最好（WebRTC + NVENC），但每个桌面一个 Python 服务 + GStreamer 栈，重；音频也没有现成的「按对话静音」语义 |
| **KasmVNC** | 只有 X11，且 NVIDIA 闭源驱动没有 DRI3 → 你的 4060 只能软件渲染；AUR 安装 |
| **Xpra** | Wayland 后端实验性，截图需要客户端连着 |
| **neko / Guacamole / webtop** | 容器级方案，一个对话一个容器太重 |
| **Xvfb + x11vnc** | 简单，但只能跑 X11，没有 Wayland 原生客户端，且没有 GPU |

headless sway + wayvnc 是这套需求里**唯一同时满足**「Wayland 原生 + X11 兼容 + GPU + 单进程 + 无额外依赖」的组合。
