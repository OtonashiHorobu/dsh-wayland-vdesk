# 用 shell 调用 dsh-vdesk

`dsh-vdesk` 既是 DSH 插件的可执行入口，也是一个独立的命令行工具。它和 agent 工具、网页面板**共用同一个守护进程**，
所以你在终端里 `run` 起来的窗口，agent 截图能看到，网页里也能操作。

```bash
dsh-vdesk <command> [options]
```

## 约定

- **KEY**：对话 key 或桌面 id。agent 工具用 DSH 的 session id 作为 key；你在终端里可以用任意短的
  可读字符串（例如 `my-app`），第一次提到它时会自动创建对应桌面。
- 所有命令默认自动拉起守护进程（`hub`），无需先 `start`。
- 输出尽量是「一行结论 + 路径」，加 `--json` 拿到结构化结果（`status` / `list` / `env` / `windows`）。

## 生命周期

```bash
dsh-vdesk start            # 后台启动 hub，打印 http://127.0.0.1:7317
dsh-vdesk status [--json]  # hub 端口 / 能力检测 / 桌面一览
dsh-vdesk stop-hub         # 停掉 hub 与所有桌面
```

`status` 里的 `caps` 是你机器上实际可用的能力：

```
hub      http://127.0.0.1:7317  (pid 439852)
caps     sway wayvnc grim wtype xdotool wlCopy pactl parec ffmpeg
novnc    ok
desktops 1
  s-0ey025q  demo  1280x800  ready  apps=1
```

## 桌面

```bash
dsh-vdesk create [--conv KEY] [--size 1280x800] [--label 名字] [--fps 24]
dsh-vdesk list [--json]
dsh-vdesk open KEY                 # 打印可粘贴到浏览器的 live view URL
dsh-vdesk resize KEY 1600x900
dsh-vdesk kill KEY | --all
```

`create` 是幂等的：同一个 KEY 再调用只会复用它（尺寸不同则顺手 resize）。

## 运行程序

```bash
# 后台运行（GUI 程序用这个），返回 pid 与日志路径
dsh-vdesk run my-app -- gtk4-demo

# 前台运行并拿到输出/退出码（脚本、构建工具用这个）
dsh-vdesk run my-app --wait -- sh -c 'echo $DISPLAY; exit 3'
echo $?   # 3
```

`run` 会把命令放进桌面的环境里执行：

| 变量 | 值 |
| --- | --- |
| `DISPLAY` | 该桌面 Xwayland 的 `:N` |
| `WAYLAND_DISPLAY` | 该桌面私有的 `wayland-1` |
| `XDG_RUNTIME_DIR` | 该桌面私有目录 |
| `SWAYSOCK` | 该桌面的 sway IPC socket |
| `PULSE_SINK` | 该桌面的 null sink |
| `PULSE_SERVER` | 你真实的 PipeWire（只用来连，不发声） |

同时会清掉 `HYPRLAND_INSTANCE_SIGNATURE`、`WAYLAND_SOCKET`、`DESKTOP_STARTUP_ID` 等会把你带回真实桌面的变量。

## 把任意 shell 注入桌面

两种写法，效果一样：

```bash
# 1) 直接执行
dsh-vdesk exec my-app -- cargo run

# 2) 导出环境，之后的命令都在桌面里
eval "$(dsh-vdesk env my-app)"
cargo run
```

`env` 输出的是标准 `export` 行：

```bash
export XDG_RUNTIME_DIR='/run/user/1000/dsh-vdesk/sessions/s-0ey025q/run'
export WAYLAND_DISPLAY='wayland-1'
export DISPLAY=':1'
export SWAYSOCK='/run/user/1000/dsh-vdesk/sessions/s-0ey025q/run/sway-ipc.1000.1234.sock'
export PULSE_SERVER='unix:/run/user/1000/pulse/native'
export PULSE_SINK='dsh_vdesk_s_0ey025q'
```

适合的场景：在 IDE 里配置运行配置、给测试脚本套一层、`ssh` 进来调试。

## 截图

```bash
dsh-vdesk shot my-app --out /tmp/a.png
dsh-vdesk shot my-app --region "0,0 640x480" --width 800 --out /tmp/crop.png
```

`--width` 用 ffmpeg 等比缩放，方便塞进上下文或贴到 PR 里。

## 输入

```bash
dsh-vdesk click my-app 640 400
dsh-vdesk click my-app 640 400 --button right
dsh-vdesk click my-app 640 400 --double
dsh-vdesk scroll my-app 640 400 down 5
dsh-vdesk type  my-app "hello world"
dsh-vdesk look  my-app 40 -10        # 相对移动指针（游戏视角）
dsh-vdesk key   my-app ctrl+t
dsh-vdesk key   my-app alt+F4
```

批量/复杂操作用 `input`（JSON 数组，和工具的 `actions` 完全一致）：

```bash
dsh-vdesk input my-app --json '[
  {"type":"move","x":100,"y":100},
  {"type":"click","x":100,"y":100},
  {"type":"type","text":"查询"},
  {"type":"key","combo":"Return"}
]'

# 或者从 stdin
cat actions.json | dsh-vdesk input my-app --stdin
```

支持的 action：

| type | 字段 | 说明 |
| --- | --- | --- |
| `move` | `x,y` | 移动指针 |
| `click` | `x,y` `button?` | 点击 |
| `drag` | `from:[x,y]` `to:[x,y]` `steps?` | 拖拽 |
| `scroll` | `x,y` `direction` `amount?` | 滚轮 |
| `type` | `text` `method?` | 输入文本；`method:"paste"` 走剪贴板（中文/长文本） |
| `look` | `dx`,`dy` | 相对位移（鼠标视角/游戏）；绝对跳转对指针锁定客户端无效 |
| `key` | `combo` | 组合键，如 `ctrl+shift+t`、`Return` |

## 窗口

```bash
dsh-vdesk windows my-app [--json]
```

```
* gtk4-demo  "GTK 4 Demo"  1200x800+40+40
  chromium   "Example"     1200x740+0+0
```

`*` 是当前焦点窗口。Wayland 原生程序和 Xwayland 程序都会列出来。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_VDESK_PORT` | `7317` | hub 端口 |
| `DSH_VDESK_RUNTIME` | `$XDG_RUNTIME_DIR/dsh-vdesk` | 运行时目录 |
| `DSH_VDESK_NOVNC` | 自动探测 | noVNC 静态目录 |
| `DSH_VDESK_WIDTH` / `DSH_VDESK_HEIGHT` | `1280` / `800` | 默认桌面尺寸 |
| `DSH_VDESK_IDLE_MS` | `14400000`（4h） | 无人使用多久后回收桌面 |

## 排查

```bash
dsh-vdesk status                 # hub 与能力是否齐全
ls $XDG_RUNTIME_DIR/dsh-vdesk/sessions/<id>/log/
tail -f .../log/sway.log         # 合成器日志
tail -f .../log/app-01.log       # 你运行的程序的输出
```

常见问题：

- **`missing sway`**：没装系统依赖，见 README。
- **画面黑屏**：`sway.log` 里看 renderer 是否初始化失败；NVIDIA 上可先试 `WLR_RENDERER=pixman` 验证是不是 GPU 路径问题。
- **`grim failed`**：桌面刚创建还没渲染完，稍等再截。
- **打字没反应**：先点一下目标窗口给焦点；Wayland 客户端不支持 IME，中文用 `method:"paste"`。
