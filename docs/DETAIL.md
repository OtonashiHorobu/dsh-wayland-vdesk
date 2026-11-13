# 虚拟桌面

给每个对话一块**离屏桌面**，用它调试 GUI 程序，而不用把窗口丢到你的真实桌面上。

## 它做什么

- **一个对话一块桌面**：按 DSH session id 绑定，两个对话互不干扰。
- **离屏渲染**：私有 headless sway（Wayland）+ Xwayland，`hyprctl clients` 永远看不到里面的窗口。
- **任意尺寸**：创建时指定，运行中还能 `vdesk_resize`。
- **双向可见**：agent 调 `vdesk_shot` 拿到 PNG；你在对话页签「虚拟桌面」里实时看、直接操作。
- **声音**：每个桌面一个独立 null sink，默认静音；网页里点「声音」才出声，旁边滑杆调音量。
- **任意程序**：`vdesk_run` 注入 `DISPLAY` / `WAYLAND_DISPLAY` / `XDG_RUNTIME_DIR` / `PULSE_SINK`，
  GTK、Qt、Electron、Chromium、Wine 都能跑。

## 怎么用

页签「虚拟桌面」→ 没有桌面时点「打开桌面」；有桌面时直接看，画面里可以用鼠标键盘操作。

agent 侧：

```text
vdesk_create({width: 1440, height: 900})
vdesk_run({command: "npm run dev"})
vdesk_shot()
vdesk_input({actions: [{type: "click", x: 320, y: 200}]})
```

命令行侧：

```bash
dsh-vdesk create --conv my-app --size 1440x900
dsh-vdesk run my-app -- cargo run
dsh-vdesk shot my-app --out /tmp/a.png
```

## 前提

```bash
sudo pacman -S sway wayvnc grim wtype wl-clipboard
```

需要 noVNC（Arch 包 `novnc`，或 `DSH_VDESK_NOVNC` 指向任意 noVNC 目录）来显示画面。

## 边界

- **仅 Linux**（Wayland 合成器 + PipeWire/PulseAudio）。
- 显示隔离不等于安全沙箱：同一 uid，程序仍可读你的文件；跑不可信程序请用容器。
- 没有输入法：中文输入请让 agent 用 `method:"paste"`。
- 桌面由后台进程 `dsh-vdesk daemon` 提供（工具、CLI、网页共用）；`dsh-vdesk status` 可以查看状态，
  `dsh-vdesk stop-hub` 会连同所有桌面一起停掉。
